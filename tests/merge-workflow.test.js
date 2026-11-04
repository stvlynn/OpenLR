import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile,mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {chromium} from 'playwright-core'
import {frame,png} from './fixtures/merge-scene.js'
import {makeDng} from './fixtures/dng.mjs'

test('multi-selected originals merge through the real WASM worker into persistent HDR and panorama photos',async t=>{
  const server=createServer(async(req,res)=>{
    try{
      const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html'
      if(!/^[\w./-]+$/.test(name)||name.includes('..'))throw Error()
      res.setHeader('Content-Type',({html:'text/html',js:'text/javascript',mjs:'text/javascript',css:'text/css',wasm:'application/wasm'})[name.split('.').pop()]||'application/octet-stream')
      res.end(await readFile(new URL('../web/'+name,import.meta.url)))
    }catch{res.writeHead(404).end()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>{server.closeAllConnections();server.close()})
  const directory=await mkdtemp(join(tmpdir(),'openlr-merge-'))
  const context=await chromium.launchPersistentContext(directory,{channel:process.env.CHROME_CHANNEL||'chrome',headless:true})
  t.after(async()=>{await context.close();await rm(directory,{recursive:true,force:true,maxRetries:4})})
  const page=context.pages()[0],errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto('http://127.0.0.1:'+server.address().port)
  await page.waitForFunction(()=>window.openlr)
  const run=(command,args={})=>page.evaluate(({command,args})=>window.openlr.run(command,args),{command,args})
  const brackets=[{ev:-2,x:5,y:-3},{ev:0},{ev:2,x:-4,y:2}].map((options,i)=>({name:'bracket-'+i+'.png',mimeType:'image/png',buffer:png(frame(600,260,{...options,hdr:true}))}))
  await page.locator('#files').setInputFiles(brackets)
  await page.waitForFunction(()=>document.querySelectorAll('#gallery .tile').length===3)
  const sources=(await run('state')).photos.map(photo=>photo.id)
  await run('select-many',{ids:sources})
  await page.locator('#merge-photos').click()
  await page.getByLabel('Merge type',{exact:true}).selectOption('hdr')
  // PNG fixtures deliberately have no EXIF; the real exposure calibration is explicit.
  const evByName={'bracket-0.png':-2,'bracket-1.png':0,'bracket-2.png':2}
  for(const [name,ev]of Object.entries(evByName))await page.getByLabel('Exposure offset for '+name,{exact:true}).fill(String(ev))
  await page.locator('#merge-dialog button[type=submit]').click()
  await page.waitForFunction(()=>!document.getElementById('merge-dialog').open,{},{timeout:30_000})
  let state=await run('state'),hdr=state.photos.find(photo=>photo.id===state.selected)
  assert.equal(state.photos.length,4)
  assert.equal(hdr.merge.kind,'hdr')
  assert.ok(hdr.merge.dynamicRangeStops>8)
  assert.equal(hdr.merge.sources.length,3)
  assert.ok(state.photos.filter(photo=>sources.includes(photo.id)).every(photo=>Object.keys(photo.edit).length===0))
  const radiance=await page.evaluate(async()=>{
    const {blob}=await window.openlr.run('export-hdr');return {type:blob.type,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))}
  })
  assert.equal(radiance.type,'image/vnd.radiance')
  assert.ok(Buffer.from(radiance.bytes).subarray(0,50).toString().startsWith('#?RADIANCE'))
  const panoramaFrames=[0,180,360].map((x,i)=>({name:'overlap-'+i+'.png',mimeType:'image/png',buffer:png(frame(360,260,{x,y:[0,7,-4][i]}))}))
  await page.locator('#files').setInputFiles(panoramaFrames)
  await page.waitForFunction(()=>document.querySelectorAll('#gallery .tile').length===7)
  state=await run('state');const panoramaSources=state.photos.filter(photo=>photo.name.startsWith('overlap-')).sort((a,b)=>a.name.localeCompare(b.name)).map(photo=>photo.id)
  await run('select-many',{ids:panoramaSources})
  await page.locator('#merge-photos').click()
  await page.getByLabel('Merge type',{exact:true}).selectOption('panorama')
  await page.locator('#merge-dialog button[type=submit]').click()
  await page.waitForFunction(()=>!document.getElementById('merge-dialog').open,{},{timeout:30_000})
  state=await run('state');const panorama=state.photos.find(photo=>photo.id===state.selected)
  assert.equal(state.photos.length,8)
  assert.equal(panorama.merge.kind,'panorama')
  assert.ok(Math.abs(panorama.width-720)<8)
  const exported=await page.evaluate(async()=>{const {blob}=await window.openlr.run('export',{format:'image/png'});return Array.from(new Uint8Array(await blob.arrayBuffer()))})
  assert.equal(Buffer.from(exported).readUInt32BE(16),panorama.width)
  await run('select',{id:sources[0]})
  const original=await page.evaluate(async()=>{const {blob}=await window.openlr.run('export',{format:'original'});return Array.from(new Uint8Array(await blob.arrayBuffer()))})
  const originalName=(await run('state')).photos.find(photo=>photo.id===sources[0]).name
  assert.deepEqual(Buffer.from(original),brackets.find(file=>file.name===originalName).buffer)
  await page.reload();await page.waitForFunction(()=>window.openlr)
  state=await run('state');assert.equal(state.photos.length,8)
  await run('select',{id:hdr.id})
  assert.equal((await page.evaluate(()=>window.openlr.dispatch('export-hdr'))).result.bytes,radiance.bytes.length)
  await page.locator('#files').setInputFiles([0,1].map(i=>({name:'flat-'+i+'.png',mimeType:'image/png',buffer:png(frame(160,120,{flat:true}))})))
  await page.waitForFunction(()=>document.querySelectorAll('#gallery .tile').length===10)
  const flat=(await run('state')).photos.filter(photo=>photo.name.startsWith('flat-')).map(photo=>photo.id)
  await run('select-many',{ids:flat})
  const failure=await page.evaluate(()=>window.openlr.dispatch('merge-panorama'))
  assert.equal(failure.ok,false)
  assert.match(failure.error.message,/no reliable/)
  assert.equal((await run('state')).photos.length,10)
  await page.locator('#files').setInputFiles([-2,0].map(ev=>({name:'raw-'+ev+'.dng',mimeType:'image/x-adobe-dng',buffer:Buffer.from(makeDng({exposure:2**ev}))})))
  await page.waitForFunction(()=>document.querySelectorAll('#gallery .tile').length===12)
  state=await run('state')
  const raw=state.photos.filter(photo=>photo.name.startsWith('raw-')).sort((a,b)=>a.name.localeCompare(b.name))
  const rawMerged=await run('merge-hdr',{ids:raw.map(photo=>photo.id),evs:raw.map(photo=>photo.name==='raw--2.dng'?-2:0),align:false})
  assert.deepEqual(rawMerged.merge.inputTransfer,['linear16-RAW','linear16-RAW'])
  assert.ok((await page.evaluate(()=>window.openlr.dispatch('export-hdr'))).result.bytes>1000)
  // Force the same startup failure seen on restricted native webview schemes.
  // The shared kernel must execute the real merge on the retained input buffers.
  await page.addInitScript(()=>{window.Worker=class{constructor(){throw Error('Forced Worker startup failure for merge verification')}}})
  await page.reload();await page.waitForFunction(()=>window.openlr)
  state=await run('state')
  const fallback=await run('merge-hdr',{ids:sources,evs:sources.map(id=>evByName[state.photos.find(photo=>photo.id===id).name])})
  assert.ok(fallback.merge.dynamicRangeStops>8)
  const workerDiagnostics=await page.evaluate(async()=>(await import('./image-worker.js')).getImageWorkerDiagnostics())
  assert.ok(workerDiagnostics.some(item=>item.worker==='merge-worker.js'&&item.fallback==='main-thread'))
  assert.deepEqual(errors,[])
  if(process.env.OPENLR_MERGE_ARTIFACTS){
    await mkdir(process.env.OPENLR_MERGE_ARTIFACTS,{recursive:true})
    await writeFile(join(process.env.OPENLR_MERGE_ARTIFACTS,'panorama.png'),Buffer.from(exported))
    await writeFile(join(process.env.OPENLR_MERGE_ARTIFACTS,'merged.hdr'),Buffer.from(radiance.bytes))
    await run('select',{id:hdr.id})
    const image=await page.evaluate(async()=>{const {blob}=await window.openlr.run('export',{format:'image/png'});return Array.from(new Uint8Array(await blob.arrayBuffer()))})
    await writeFile(join(process.env.OPENLR_MERGE_ARTIFACTS,'hdr-tone-mapped.png'),Buffer.from(image))
    await page.screenshot({path:join(process.env.OPENLR_MERGE_ARTIFACTS,'merge-workspace.png')})
  }
})
