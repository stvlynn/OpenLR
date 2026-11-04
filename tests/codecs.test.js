import test from 'node:test'
import assert from 'node:assert/strict'
import {serveWorkspace} from './browser-server.mjs'
import {chromium} from 'playwright-core'
import {EXPORT_TYPES,exportFilename} from '../web/formats.js'
import {parse} from '../cli/openlr.mjs'

test('shared format list keeps existing order and correct filename extensions',()=>{
  assert.deepEqual(EXPORT_TYPES.slice(0,6),['image/jpeg','image/png','original','image/tiff','image/avif','image/jxl'])
  for(const [format,extension]of [['image/tiff','tif'],['image/avif','avif'],['image/jxl','jxl']]){
    assert.equal(exportFilename('camera.raw',format),'camera.'+extension)
    assert.equal(parse(['export','--format',format,'--dry-run']).args.format,format)
  }
})
test('real TIFF/AVIF/JXL encode/decode round trips, signatures, alpha and GUI export',async t=>{
  let isolated=false
  const server=await serveWorkspace(()=>isolated)
  t.after(server.close)
  const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true})
  t.after(()=>browser.close())
  const page=await browser.newPage()
  await page.goto(server.url)
  const results=await page.evaluate(async()=>{
    const {encodePhoto}=await import('./encode.js'),{decodePhoto}=await import('./decode.js'),{run}=await import('./app.js')
    const canvas=document.createElement('canvas');canvas.width=32;canvas.height=24
    const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(32,24)
    for(let y=0;y<24;y++)for(let x=0;x<32;x++){
      const i=(y*32+x)*4;pixels.data[i]=x*7;pixels.data[i+1]=y*9;pixels.data[i+2]=(x+y)*4;pixels.data[i+3]=x<8?128:255
    }
    ctx.putImageData(pixels,0,0)
    const reference=ctx.getImageData(0,0,32,24).data
    const records=[]
    for(const [format,extension]of [['image/tiff','tif'],['image/avif','avif'],['image/jxl','jxl']]){
      const blob=await encodePhoto(canvas,format,1),buffer=await blob.arrayBuffer(),head=Array.from(new Uint8Array(buffer).slice(0,16))
      const file=new File([blob],'gradient.'+extension,{type:format}),bitmap=await decodePhoto(file)
      const out=document.createElement('canvas');out.width=bitmap.width;out.height=bitmap.height;out.getContext('2d').drawImage(bitmap,0,0);bitmap.close()
      const actual=out.getContext('2d').getImageData(0,0,32,24).data
      let maxDifference=0
      for(let i=0;i<reference.length;i++)maxDifference=Math.max(maxDifference,Math.abs(reference[i]-actual[i]))
      const imported=await run('import',{files:[file]})
      if(imported.failed.length)throw Error(JSON.stringify(imported.failed))
      const exported=await run('export',{format,quality:1})
      let lossyDifference
      if(format!=='image/tiff'){
        const lossy=await encodePhoto(canvas,format,0.5),decoded=await decodePhoto(new File([lossy],'lossy.'+extension,{type:format}))
        out.getContext('2d').clearRect(0,0,32,24);out.getContext('2d').drawImage(decoded,0,0);decoded.close()
        const reduced=out.getContext('2d').getImageData(0,0,32,24).data
        lossyDifference=reduced.reduce((sum,v,i)=>sum+Math.abs(v-reference[i]),0)/reduced.length
      }
      records.push({format,type:blob.type,size:buffer.byteLength,head,width:out.width,height:out.height,maxDifference,lossyDifference,filename:exported.filename,exportType:exported.blob.type})
      const corrupt=new File(['invalid'],'broken.'+extension,{type:format})
      let failed=false;try{const b=await decodePhoto(corrupt);b.close()}catch{failed=true}
      if(!failed)throw Error('Invalid '+format+' was accepted')
    }
    const {default:UTIF}=await import('./vendor/codecs/utif.js')
    const {default:pako}=await import('./vendor/codecs/pako.js'),compressed=pako.deflate(reference)
    const deflateImage=new Uint8Array(UTIF.encodeImage(reference.buffer,32,24,{t259:[8],t279:[compressed.length],t338:[2]})).slice(0,1000+compressed.length)
    deflateImage.set(compressed,1000)
    const deflated=await decodePhoto(new File([deflateImage],'deflate.tif',{type:'image/tiff'}))
    const check=document.createElement('canvas');check.width=32;check.height=24;check.getContext('2d').drawImage(deflated,0,0);deflated.close()
    const decodedDeflate=check.getContext('2d').getImageData(0,0,32,24).data
    if(decodedDeflate.some((value,index)=>value!==reference[index]))throw Error('Deflate TIFF pixel mismatch')
    const oriented=UTIF.encodeImage(reference.buffer,32,24,{t274:[6],t338:[2]}),rotated=await decodePhoto(new File([oriented],'rotate.tif',{type:'image/tiff'}))
    if(rotated.width!==24||rotated.height!==32)throw Error('TIFF orientation was ignored')
    rotated.close()
    const premultiplied=UTIF.encodeImage(Uint8Array.from([128,0,0,128]).buffer,1,1,{t338:[1]}),alpha=await decodePhoto(new File([premultiplied],'alpha.tif',{type:'image/tiff'}))
    const single=document.createElement('canvas');single.width=single.height=1;single.getContext('2d').drawImage(alpha,0,0);alpha.close()
    const pixel=single.getContext('2d').getImageData(0,0,1,1).data
    if(pixel[0]!==255||pixel[3]!==128)throw Error('TIFF associated alpha was not converted')
    return records
  })
  for(const result of results){
    assert.equal(result.width,32);assert.equal(result.height,24)
    assert.equal(result.type,result.format);assert.equal(result.exportType,result.format)
    assert.ok(result.maxDifference<=2,JSON.stringify(result))
    if(result.lossyDifference!==undefined)assert.ok(result.lossyDifference>0&&result.lossyDifference<20,JSON.stringify(result))
  }
  const [tiff,avif,jxl]=results
  assert.ok((tiff.head[0]===77&&tiff.head[1]===77&&tiff.head[2]===0&&tiff.head[3]===42)||(tiff.head[0]===73&&tiff.head[1]===73&&tiff.head[2]===42&&tiff.head[3]===0))
  assert.equal(String.fromCharCode(...avif.head.slice(4,8)),'ftyp')
  assert.equal(String.fromCharCode(...avif.head.slice(8,12)),'avif')
  assert.ok((jxl.head[0]===255&&jxl.head[1]===10)||(jxl.head[4]===74&&jxl.head[5]===88&&jxl.head[6]===76))
  assert.equal(tiff.filename,'gradient.tif');assert.equal(avif.filename,'gradient.avif');assert.equal(jxl.filename,'gradient.jxl')
  await page.locator('#export').click()
  assert.deepEqual(await page.locator('#format option').evaluateAll(options=>options.map(o=>o.value)),EXPORT_TYPES)
  await page.locator('#format').selectOption('image/tiff');assert.equal(await page.locator('#quality').isVisible(),false)
  await page.locator('#format').selectOption('image/jxl');assert.equal(await page.locator('#quality').isVisible(),true)
  isolated=true
  await page.goto(server.url+'/?isolated=1')
  const threaded=await page.evaluate(async()=>{
    if(!crossOriginIsolated)throw Error('Thread test was not isolated')
    const {encodePhoto}=await import('./encode.js'),{decodePhoto}=await import('./decode.js'),canvas=document.createElement('canvas')
    canvas.width=32;canvas.height=24;canvas.getContext('2d').fillRect(0,0,32,24)
    const results=[]
    for(const [type,extension]of [['image/avif','avif'],['image/jxl','jxl']]){
      const blob=await encodePhoto(canvas,type,0.5),bitmap=await decodePhoto(new File([blob],'threaded.'+extension,{type}))
      results.push([bitmap.width,bitmap.height]);bitmap.close()
    }
    return results
  })
  assert.deepEqual(threaded,[[32,24],[32,24]])
  console.log('Codec round trips:',JSON.stringify(results))
})
