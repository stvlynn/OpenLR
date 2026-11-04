import test from 'node:test'
import assert from 'node:assert/strict'
import {serveWorkspace} from './browser-server.mjs'
import {chromium} from 'playwright-core'
import {applyLocalTools,validateLocalTool,updateLocalTools} from '../web/local-tools.js'
import {originalToView,viewToOriginal} from '../web/local-tools-ui.js'
import {parse} from '../cli/openlr.mjs'

function pixels(width=64,height=64,value=100){return {width,height,data:Uint8ClampedArray.from({length:width*height*4},(_,i)=>i%4===3?255:value)}}
const at=(image,x,y)=>Array.from(image.data.slice((y*image.width+x)*4,(y*image.width+x)*4+4))
test('masks localize exposure with feather and inverse, repairs clone and match destination tone',()=>{
  const radial=validateLocalTool('mask',{type:'radial',center:{x:0.5,y:0.5},rx:0.2,ry:0.2,feather:0.5,adjustments:{Exposure:1}})
  const image=pixels();applyLocalTools(image,{masks:[radial]})
  assert.deepEqual(at(image,0,0),[100,100,100,255])
  assert.ok(at(image,32,32)[0]>130)
  const inverse=pixels();applyLocalTools(inverse,{masks:[{...radial,invert:true}]})
  assert.equal(at(inverse,32,32)[0],100);assert.ok(at(inverse,0,0)[0]>130)
  const original=pixels(64,64,200)
  for(let y=4;y<20;y++)for(let x=4;x<20;x++)for(let c=0;c<3;c++)original.data[(y*64+x)*4+c]=100
  for(let c=0;c<3;c++)original.data[(48*64+48)*4+c]=0
  const repair=validateLocalTool('repair',{type:'clone',source:{x:12.5/64,y:12.5/64},points:[{x:48.5/64,y:48.5/64}],radius:0.1,feather:0})
  const clone={...original,data:original.data.slice()};applyLocalTools(clone,{repairs:[repair]})
  assert.equal(at(clone,48,48)[0],100)
  assert.deepEqual(at(clone,0,0),[200,200,200,255])
  const healed={...original,data:original.data.slice()};applyLocalTools(healed,{repairs:[{...repair,type:'heal'}]})
  assert.ok(at(healed,48,48)[0]>190&&at(healed,48,48)[0]<=200)
  assert.equal(at(original,48,48)[0],0)
})
test('original coordinates round trip through crop/quarter turns/reflection, CLI validates nested recipes',()=>{
  const image={width:1200,height:800},point={x:0.45,y:0.4}
  for(let turn=0;turn<4;turn++)for(const flip of [false,true]){
    const edit={crop:{x:0.2,y:0.1,w:0.6,h:0.8},turn,flip}
    const restored=viewToOriginal(originalToView(point,image,edit),image,edit)
    assert.ok(Math.abs(restored.x-point.x)<1e-12&&Math.abs(restored.y-point.y)<1e-12)
  }
  const mask={type:'brush',points:[{x:0.5,y:0.5}],radius:0.1,adjustments:{Exposure:1}}
  assert.equal(parse(['mask.add','--args',JSON.stringify({mask}),'--dry-run']).args.mask.type,'brush')
  assert.throws(()=>parse(['mask.add','--args',JSON.stringify({mask:{...mask,points:[{x:2,y:0}]}})]),/between/)
  assert.throws(()=>parse(['mask.update','--args',JSON.stringify({id:'x',changes:{adjustments:{Exposure:9}}})]),/between/)
  let edit=updateLocalTools({},'repair.add',{repair:{type:'clone',source:{x:0.1,y:0.1},points:[{x:0.5,y:0.5}]}})
  const id=edit.localTools.repairs[0].id
  edit=updateLocalTools(edit,'repair.update',{id,changes:{opacity:0.4}})
  assert.equal(edit.localTools.repairs[0].opacity,0.4)
  assert.equal(updateLocalTools(edit,'repair.remove',{id}).localTools.repairs.length,0)
})
test('UI brush and shared commands alter real pixels, survive reload, undo, export and crop geometry',async t=>{
  const server=await serveWorkspace()
  t.after(server.close)
  const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true})
  t.after(()=>browser.close())
  const page=await browser.newPage({viewport:{width:1400,height:1000}})
  await page.goto(server.url)
  await page.evaluate(async()=>{
    const {run}=await import('./app.js'),canvas=document.createElement('canvas');canvas.width=100;canvas.height=80
    const ctx=canvas.getContext('2d');ctx.fillStyle='rgb(100,100,100)';ctx.fillRect(0,0,100,80)
    ctx.fillStyle='blue';ctx.fillRect(4,4,15,15)
    const blob=await new Promise(resolve=>canvas.toBlob(resolve))
    await run('import',{files:[new File([blob],'local-test.png',{type:'image/png'})]});await run('view',{mode:'detail'})
  })
  await page.getByText('Masks & local repair',{exact:true}).click()
  await page.getByLabel('Local tool',{exact:true}).selectOption('brush')
  await page.getByLabel('Local Exposure',{exact:true}).fill('1')
  const canvas=page.locator('#stage canvas'),bounds=await canvas.boundingBox()
  await page.mouse.move(bounds.x+bounds.width*0.5,bounds.y+bounds.height*0.5)
  await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*0.65,bounds.y+bounds.height*0.5,{steps:5});await page.mouse.up()
  await page.waitForFunction(async()=>((await import('./app.js')).run('state')).then(s=>s.photos[0].edit.localTools?.masks.length===1))
  const center=()=>page.locator('#stage canvas').evaluate(c=>c.getContext('2d').getImageData(Math.floor(c.width*0.55),Math.floor(c.height*0.5),1,1).data[0])
  assert.ok(await center()>130)
  await page.evaluate(async()=>{const {run}=await import('./app.js');await run('undo')})
  assert.equal(await center(),100)
  await page.evaluate(async()=>{const {run}=await import('./app.js');await run('redo')})
  assert.ok(await center()>130)
  await page.reload();await page.locator('#gallery .tile').waitFor()
  await page.evaluate(async()=>{const {run}=await import('./app.js');await run('view',{mode:'detail'})})
  assert.ok(await center()>130)
  const output=await page.evaluate(async()=>{
    const {run}=await import('./app.js')
    await run('repair.add',{repair:{type:'clone',source:{x:0.1,y:0.1},points:[{x:0.8,y:0.75}],radius:0.05,feather:0}})
    await run('edit',{key:'crop',value:{x:0.4,y:0.25,w:0.6,h:0.75}})
    await run('edit',{key:'turn',value:1});await run('edit',{key:'flip',value:true})
    const state=await run('state'),{blob}=await run('export',{format:'image/png'})
    const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height
    const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close()
    const {originalToView}=await import('./local-tools-ui.js')
    const point=originalToView({x:0.8,y:0.75},{width:100,height:80},state.photos[0].edit)
    return {size:[canvas.width,canvas.height],clone:Array.from(context.getImageData(Math.floor(point.x*canvas.width),Math.floor(point.y*canvas.height),1,1).data),masks:state.photos[0].edit.localTools.masks.length}
  })
  assert.equal(output.masks,1)
  assert.deepEqual(output.size,[60,60])
  assert.ok(output.clone[2]>240&&output.clone[0]<10,JSON.stringify(output))
})
