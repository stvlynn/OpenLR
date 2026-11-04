import test from 'node:test'
import assert from 'node:assert/strict'
import {chromium} from 'playwright-core'
import {serveWorkspace} from './browser-server.mjs'
import {makeDng} from './fixtures/dng.mjs'
import {readFile} from 'node:fs/promises'

test('DNG preserves existing sensor bytes and writes genuine 16-bit linear RGB with valid calibration and settings',async t=>{
  const server=await serveWorkspace();t.after(server.close)
  const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true});t.after(()=>browser.close())
  const page=await browser.newPage();await page.goto(server.url)
  const result=await page.evaluate(async fixture=>{
    const {decodePhotoLinear}=await import('./decode.js'),{encodeLinearDng,exportDng,isDng}=await import('./dng.js'),{exportXmp}=await import('./xmp.js')
    const UTIF=(await import('./vendor/codecs/utif.js')).default
    const source=new File([new Uint8Array(fixture)],'sensor.dng',{type:'image/x-adobe-dng'}),photo={name:'sensor.dng',width:96,height:128,edit:{Exposure:1.25},rating:4,keywords:'linear, sensor'}
    const existing=await exportDng(photo,source)
    const hash=async blob=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).join(',')
    const linear=await decodePhotoLinear(source)
    const encoded=encodeLinearDng(linear,{sourceName:'source-camera.nef',xmp:exportXmp(photo),metadata:{ExposureTime:1/125,FNumber:5.6,ISO:200}})
    const file=new File([encoded],'linear.dng',{type:'image/x-adobe-dng'}),bytes=await encoded.arrayBuffer(),ifd=UTIF.decode(bytes)[0]
    const output=await decodePhotoLinear(file)
    let error=0,maxError=0,precise=0
    for(let i=0;i<linear.linear.length;i++){
      const difference=Math.abs(linear.linear[i]-output.linear[i]);error+=difference;maxError=Math.max(maxError,difference)
      if(linear.linear[i]>0&&linear.linear[i]<1&&Math.abs(linear.linear[i]*255-Math.round(linear.linear[i]*255))>0.01)precise++
    }
    const view=new DataView(bytes),offsets=ifd.t273,counts=ifd.t279
    let storedError=0,index=0
    for(let s=0;s<offsets.length;s++)for(let offset=offsets[s];offset<offsets[s]+counts[s];offset+=2,index++)storedError=Math.max(storedError,Math.abs(view.getUint16(offset,true)/65535-linear.linear[index]))
    let rejected=false
    try{await exportDng({...photo,name:'render.png'},new File(['not RAW'],'render.png',{type:'image/png'}))}catch(error){rejected=/not RAW|requires/.test(error.message)}
    return {preserved:await hash(source)===await hash(existing.blob),mode:existing.mode,valid:await isDng(file),dimensions:[output.width,output.height],bits:ifd.t258,photometric:ifd.t262,black:ifd.t50714,white:ifd.t50717,orientation:ifd.t274,matrix:ifd.t50721,illuminant:ifd.t50778,neutral:ifd.t50728,xmp:new TextDecoder().decode(Uint8Array.from(ifd.t700)),samples:index,storedError,meanError:error/linear.linear.length,maxError,precise,rejected,bytes:encoded.size}
  },Array.from(makeDng({orientation:6})))
  console.log('DNG roundtrip:',JSON.stringify({...result,xmp:result.xmp.slice(0,40)}))
  assert.equal(result.preserved,true);assert.equal(result.mode,'original-dng');assert.equal(result.valid,true)
  assert.deepEqual(result.dimensions,[96,128]);assert.deepEqual(result.bits,[16,16,16]);assert.deepEqual(result.photometric,[34892])
  assert.deepEqual(result.orientation,[1]);assert.deepEqual(result.black,[0,0,0]);assert.deepEqual(result.white,[65535,65535,65535])
  assert.deepEqual(result.illuminant,[21]);assert.deepEqual(result.neutral,[1,1,1]);assert.equal(result.matrix.length,9)
  assert.equal(result.samples,96*128*3);assert.ok(result.storedError<1/65535)
  assert.ok(result.precise>100);assert.ok(result.meanError<0.02);assert.ok(result.maxError<0.08)
  assert.match(result.xmp,/Exposure2012="1.25"/);assert.equal(result.rejected,true)
})

test('an actual CC0 Canon CRW exports through GUI commands to LinearRaw DNG and decodes without baking display edits',async t=>{
  const server=await serveWorkspace();t.after(server.close)
  const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true});t.after(()=>browser.close())
  const page=await browser.newPage();await page.goto(server.url)
  const filename=new URL('./fixtures/raw/canon-powershot-g1.crw',import.meta.url)
  await page.locator('#files').setInputFiles({name:'canon-powershot-g1.crw',mimeType:'image/x-canon-crw',buffer:await readFile(filename)})
  await page.waitForFunction(()=>document.querySelectorAll('#gallery .tile').length===1)
  const result=await page.evaluate(async()=>{
    const {run}=await import('./app.js'),{original}=await import('./catalog.js'),{decodePhotoLinear}=await import('./decode.js'),{isDng}=await import('./dng.js')
    const state=await run('state'),source=await original(state.selected),linear=await decodePhotoLinear(source.file)
    await run('edit',{key:'Exposure',value:1.25})
    const output=await run('export',{format:'image/x-adobe-dng'}),file=new File([output.blob],output.filename,{type:'image/x-adobe-dng'}),decoded=await decodePhotoLinear(file)
    const {default:UTIF}=await import('./vendor/codecs/utif.js'),bytes=await output.blob.arrayBuffer(),ifd=UTIF.decode(bytes)[0]
    let maxError=0,sum=0,sub8=0
    for(let i=0;i<linear.linear.length;i++){
      const delta=Math.abs(linear.linear[i]-decoded.linear[i]);maxError=Math.max(maxError,delta);sum+=delta
      if(linear.linear[i]>0&&linear.linear[i]<1&&Math.abs(linear.linear[i]*255-Math.round(linear.linear[i]*255))>0.01)sub8++
    }
    const digest=await crypto.subtle.digest('SHA-256',await source.file.arrayBuffer()),sourceHash=Array.from(new Uint8Array(digest)).map(value=>value.toString(16).padStart(2,'0')).join('')
    return {mode:output.mode,valid:await isDng(file),sourceIsDng:await isDng(source.file),dimensions:[decoded.width,decoded.height],sourceDimensions:[linear.width,linear.height],maxError,meanError:sum/linear.linear.length,sub8,bits:ifd.t258,photometric:ifd.t262,orientation:ifd.t274,sourceHash,xmp:new TextDecoder().decode(Uint8Array.from(ifd.t700)),bytes:output.blob.size,type:output.blob.type,filename:output.filename}
  })
  console.log('Camera CRW conversion:',JSON.stringify({...result,xmp:result.xmp.slice(0,40)}))
  assert.equal(result.mode,'linear-raw-16');assert.equal(result.valid,true);assert.equal(result.sourceIsDng,false)
  assert.deepEqual(result.dimensions,result.sourceDimensions);assert.deepEqual(result.bits,[16,16,16]);assert.deepEqual(result.photometric,[34892]);assert.deepEqual(result.orientation,[1])
  assert.equal(result.sourceHash,'f39be5acf14057ce04527fd8d0574e57ec8ed5fed082d7bfaff763075a44ee8a')
  assert.ok(result.sub8>1000);assert.ok(result.meanError<0.0001);assert.ok(result.maxError<0.001)
  assert.match(result.xmp,/Exposure2012="1.25"/);assert.equal(result.type,'image/x-adobe-dng');assert.match(result.filename,/\.dng$/)
})
