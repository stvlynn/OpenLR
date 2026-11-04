import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright-core'
import {makeDng} from './fixtures/dng.mjs'

test('Worker construction and module-load failures use the same real kernels without detaching input',async t=>{
  const server=createServer(async(req,res)=>{
    try{
      const file=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html'
      if(file.includes('..')||!/^[\w./-]+$/.test(file))throw Error()
      res.setHeader('Content-Type',/\.m?js$/.test(file)?'text/javascript':file.endsWith('.wasm')?'application/wasm':file.endsWith('.css')?'text/css':'text/html')
      res.end(await readFile(new URL('../web/'+file,import.meta.url)))
    }catch{res.writeHead(404).end()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>{server.closeAllConnections();server.close()})
  const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true})
  t.after(()=>browser.close())
  const page=await browser.newPage()
  await page.goto('http://127.0.0.1:'+server.address().port)
  const result=await page.evaluate(async fixture=>{
    const {decodePhoto,decodePhotoLinear}=await import('./decode.js'),{encodePhoto}=await import('./encode.js'),{getImageWorkerDiagnostics}=await import('./image-worker.js')
    const file=new File([new Uint8Array(fixture)],'sensor.dng',{type:'image/x-adobe-dng'})
    // A processed corrupt input is an ordinary decode error, never a startup retry.
    try{await decodePhoto(new File(['bad'],'bad.dng'))}catch{}
    if(getImageWorkerDiagnostics().length)throw Error('Decode failure incorrectly retried on main thread')
    const NativeWorker=window.Worker,records=[]
    for(const scenario of ['constructor','module-load']){
      window.Worker=scenario==='constructor'?class{constructor(){throw new DOMException('Workers unavailable in this host','SecurityError')}}:class extends NativeWorker{constructor(){super(new URL('./missing-worker.js',location.href),{type:'module'})}}
      const raw=await decodePhoto(file)
      const linear=await decodePhotoLinear(file)
      if(linear.width!==raw.width||linear.linear.length!==raw.width*raw.height*3)throw Error('Linear RAW fallback failed')
      records.push({scenario,raw:[raw.width,raw.height]});raw.close()
      const canvas=document.createElement('canvas');canvas.width=16;canvas.height=12
      const ctx=canvas.getContext('2d');ctx.fillStyle='rgb(50,100,150)';ctx.fillRect(0,0,16,12)
      for(const [format,extension]of [['image/tiff','tif'],['image/avif','avif'],['image/jxl','jxl']]){
        const blob=await encodePhoto(canvas,format,1),bitmap=await decodePhoto(new File([blob],'sample.'+extension,{type:format}))
        ctx.clearRect(0,0,16,12);ctx.drawImage(bitmap,0,0);bitmap.close()
        records.push({scenario,format,size:blob.size,pixel:Array.from(ctx.getImageData(8,6,1,1).data)})
      }
    }
    window.Worker=NativeWorker
    return {records,diagnostics:getImageWorkerDiagnostics()}
  },Array.from(makeDng()))
  assert.equal(result.records.length,8)
  for(const record of result.records){
    if(record.raw)assert.deepEqual(record.raw,[128,96])
    else{assert.ok(record.size>0);assert.deepEqual(record.pixel,[50,100,150,255])}
  }
  assert.equal(result.diagnostics.length,16)
  assert.ok(result.diagnostics.every(item=>item.phase==='startup'&&item.fallback==='main-thread'))
})
