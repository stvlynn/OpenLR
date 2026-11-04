import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright-core'
import {parse} from '../cli/openlr.mjs'
import {encodeSoftMask,sampleSoftMask} from '../web/soft-mask.js'
import {applyLocalTools,validateLocalTool} from '../web/local-tools.js'
import {AI_MODELS} from '../web/ai-models.js'

test('semantic rasters use normalized soft coverage and CLI names actual model targets',()=>{
  const raster=encodeSoftMask({width:2,height:1,mask:Uint8Array.from([0,255])})
  assert.equal(sampleSoftMask(raster,0.25,0.5),0)
  assert.equal(sampleSoftMask(raster,0.75,0.5),1)
  assert.equal(sampleSoftMask(raster,0.5,0.5),0.5)
  const tool=validateLocalTool('mask',{type:'semantic',raster,adjustments:{Exposure:1}}),pixels={width:2,height:1,data:Uint8ClampedArray.from([100,100,100,255,100,100,100,255])}
  applyLocalTools(pixels,{masks:[tool]});assert.equal(pixels.data[0],100);assert.ok(pixels.data[4]>130)
  assert.equal(parse(['ai-mask','--target','sky','--dry-run']).args.target,'sky')
  assert.throws(()=>parse(['ai-mask','--target','blue-color']),/one of/)
})
test('real local subject/person inference, UI, original preservation and persisted soft edit',async t=>{
  const server=createServer(async(req,res)=>{
    try{
      const file=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html'
      if(file==='sky.onnx'){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','application/octet-stream');res.end(await readFile(new URL('../.tools/ai-models/detr-fp32.onnx',import.meta.url)));return}
      if(file.includes('..')||!/^[\w./-]+$/.test(file))throw Error()
      const path=file.startsWith('fixtures/')?'../tests/'+file:'../web/'+file
      res.setHeader('Content-Type',/\.m?js$/.test(file)?'text/javascript':file.endsWith('.wasm')?'application/wasm':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html')
      res.end(await readFile(new URL(path,import.meta.url)))
    }catch{res.writeHead(404).end()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>{server.closeAllConnections();server.close()})
  const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true})
  t.after(()=>browser.close())
  const page=await browser.newPage({viewport:{width:1400,height:1000}}),url='http://127.0.0.1:'+server.address().port
  await page.goto(url)
  await page.evaluate(async()=>{
    const {run}=await import('./app.js'),file=new File([await(await fetch('./fixtures/ai/astronaut.png')).blob()],'astronaut.png',{type:'image/png'})
    await run('import',{files:[file]});await run('view',{mode:'detail'})
  })
  await page.getByText('Masks & local repair',{exact:true}).click()
  await page.getByLabel('AI mask target',{exact:true}).selectOption('person')
  await page.getByRole('button',{name:'Generate AI mask',exact:true}).click()
  await page.waitForFunction(async()=>((await import('./app.js')).run('state')).then(s=>s.photos[0].edit.localTools?.masks[0]?.provenance.target==='person'))
  const person=await page.evaluate(async()=>{
    const {run}=await import('./app.js'),{sampleSoftMask}=await import('./soft-mask.js'),state=await run('state'),tool=state.photos[0].edit.localTools.masks[0]
    const before=await run('export',{format:'original'}),source=await before.blob.arrayBuffer()
    const edited=await run('export',{format:'image/png'}),bitmap=await createImageBitmap(edited.blob),original=await createImageBitmap(before.blob)
    const a=document.createElement('canvas'),b=document.createElement('canvas');a.width=b.width=512;a.height=b.height=512
    a.getContext('2d').drawImage(bitmap,0,0);b.getContext('2d').drawImage(original,0,0);bitmap.close();original.close()
    const data=a.getContext('2d').getImageData(0,0,512,512).data,reference=b.getContext('2d').getImageData(0,0,512,512).data
    const delta=(x,y)=>{const i=(Math.floor(y*512)*512+Math.floor(x*512))*4;return Math.abs(data[i]-reference[i])+Math.abs(data[i+1]-reference[i+1])+Math.abs(data[i+2]-reference[i+2])}
    const after=await run('export',{format:'original'})
    return {person:sampleSoftMask(tool.raster,0.43,0.25),background:sampleSoftMask(tool.raster,0.07,0.1),interiorDelta:delta(0.43,0.25),backgroundDelta:delta(0.07,0.1),unchanged:String(new Uint8Array(source))===String(new Uint8Array(await after.blob.arrayBuffer()))}
  })
  assert.ok(person.person>0.9);assert.ok(person.background<0.05);assert.ok(person.interiorDelta>10);assert.equal(person.backgroundDelta,0);assert.equal(person.unchanged,true)
  await page.reload();await page.locator('#gallery .tile').waitFor()
  const persisted=await page.evaluate(async()=>{const {run}=await import('./app.js');const s=await run('state');return s.photos[0].edit.localTools.masks[0].provenance.target})
  assert.equal(persisted,'person')
  const complement=await page.evaluate(async()=>{
    const {generateAiMask}=await import('./ai-mask.js'),{decodeSoftMask}=await import('./soft-mask.js'),bitmap=await createImageBitmap(await(await fetch('./fixtures/ai/astronaut.png')).blob()),NativeWorker=window.Worker
    window.Worker=class{constructor(){throw new DOMException('Model worker unavailable','SecurityError')}}
    try{
      const subject=await generateAiMask(bitmap,{target:'subject'}),background=await generateAiMask(bitmap,{target:'background'})
      const a=decodeSoftMask(subject.mask.raster),b=decodeSoftMask(background.mask.raster)
      return {count:a.length,complement:a.every((value,index)=>Math.abs(value+b[index]-255)<=1),model:subject.mask.provenance.model}
    }finally{window.Worker=NativeWorker;bitmap.close()}
  })
  assert.equal(complement.count,320*320);assert.equal(complement.complement,true);assert.equal(complement.model,'u2netp.onnx')
  let skyBytes
  try{skyBytes=await readFile(new URL('../.tools/ai-models/detr-fp32.onnx',import.meta.url))}catch{}
  await t.test('actual COCO sky category 187, one-time cache and offline reuse',{skip:!skyBytes},async()=>{
    let downloads=0
    await page.route(AI_MODELS.sky.url,route=>{downloads++;return route.fulfill({status:302,headers:{location:url+'/sky.onnx','access-control-allow-origin':'*'}})})
    const first=await page.evaluate(async()=>{
      const {run}=await import('./app.js'),file=new File([await(await fetch('./fixtures/ai/rocket.jpg')).blob()],'rocket.jpg',{type:'image/jpeg'})
      await run('import',{files:[file]})
      await run('ai-mask',{target:'sky'})
      const {decodeSoftMask}=await import('./soft-mask.js'),state=await run('state'),item=state.photos.find(photo=>photo.id===state.selected).edit.localTools.masks[0],values=decodeSoftMask(item.raster)
      return {label:item.provenance.label,name:item.provenance.labelName,coverage:values.reduce((sum,v)=>sum+v,0)/values.length/255,max:Math.max(...values),min:Math.min(...values)}
    })
    assert.equal(first.label,187);assert.equal(first.name,'sky-other-merged');assert.ok(first.coverage>0.3&&first.coverage<0.95);assert.ok(first.max>220&&first.min<100)
    await page.reload();await page.locator('#gallery .tile').first().waitFor()
    await page.evaluate(async()=>{const {run}=await import('./app.js');await run('ai-mask',{target:'sky'})})
    assert.equal(downloads,1)
  })
})
