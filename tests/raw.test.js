import test from 'node:test'
import assert from 'node:assert/strict'
import {serveWorkspace} from './browser-server.mjs'
import {chromium} from 'playwright-core'
import {makeDng} from './fixtures/dng.mjs'

test('real WASM decodes generated sensor DNG, orientation, recovery and bitmap ownership',async t=>{
  const server=await serveWorkspace()
  t.after(server.close)
  const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true})
  t.after(()=>browser.close())
  const page=await browser.newPage()
  await page.goto(server.url)
  const fixture=Array.from(makeDng()), rotated=Array.from(makeDng({orientation:6}))
  const result=await page.evaluate(async({fixture,rotated})=>{
    const {decodePhoto}=await import('./decode.js')
    const NativeWorker=window.Worker
    let workers=0,terminated=0,live=0,maxLive=0
    window.Worker=class extends NativeWorker{
      constructor(...args){super(...args);workers++;live++;maxLive=Math.max(live,maxLive)}
      terminate(){terminated++;live--;super.terminate()}
    }
    const file=new File([new Uint8Array(fixture)],'sensor.dng',{type:'image/x-adobe-dng'})
    const before=await crypto.subtle.digest('SHA-256',await file.arrayBuffer())
    const bitmap=await decodePhoto(file)
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height
    const context=canvas.getContext('2d');context.drawImage(bitmap,0,0)
    const pixels=[16,64,112].map(x=>Array.from(context.getImageData(x,48,1,1).data))
    const dimensions=[bitmap.width,bitmap.height];bitmap.close()
    let invalidCode
    try{await decodePhoto(new File(['not a raw'],'bad.dng'))}catch(error){invalidCode=error.code}
    const two=await decodePhoto(new File([new Uint8Array(rotated)],'rotate.dng'))
    const rotatedDimensions=[two.width,two.height];two.close()
    const retry=await decodePhoto(file)
    const recovered=[retry.width,retry.height];retry.close()
    const parallel=await Promise.all([decodePhoto(file),decodePhoto(file)])
    parallel.forEach(image=>image.close())
    const limits=[]
    for(const input of [new File([],'empty.dng')]){
      try{await decodePhoto(input)}catch(error){limits.push(error.code)}
    }
    const after=await crypto.subtle.digest('SHA-256',await file.arrayBuffer())
    window.Worker=NativeWorker
    return {dimensions,rotatedDimensions,pixels,invalidCode,recovered,limits,workers,terminated,maxLive,unchanged:String(new Uint8Array(before))===String(new Uint8Array(after)),closedWidth:bitmap.width}
  },{fixture,rotated})
  assert.deepEqual(result.dimensions,[128,96])
  assert.deepEqual(result.rotatedDimensions,[96,128])
  assert.deepEqual(result.recovered,[128,96])
  assert.equal(result.invalidCode,'RAW_DECODE')
  assert.equal(result.unchanged,true)
  assert.equal(result.closedWidth,0)
  assert.deepEqual(result.limits,['EMPTY'])
  assert.equal(result.workers,6)
  assert.equal(result.terminated,6)
  assert.equal(result.maxLive,1)
  const [red,green,blue]=result.pixels
  assert.ok(red[0]>red[2]+40,JSON.stringify(result))
  assert.ok(green[1]>green[0]+40,JSON.stringify(result))
  assert.ok(blue[2]>blue[0]+40,JSON.stringify(result))
  console.log('RAW decode result:',JSON.stringify(result))
})
