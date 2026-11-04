import test from 'node:test'
import assert from 'node:assert/strict'
import {chromium} from 'playwright-core'
import {unzipSync,strFromU8} from 'fflate'
import {serveWorkspace} from './browser-server.mjs'
import {makeDng} from './fixtures/dng.mjs'

test('camera metadata, presets, paired XMP and rendered export dimensions survive real UI use',async t=>{
  const server=await serveWorkspace();t.after(server.close)
  const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome'});t.after(()=>browser.close())
  const page=await browser.newPage();await page.goto(server.url)
  const run=(command,args={})=>page.evaluate(([command,args])=>window.openlr.run(command,args),[command,args])
  const raw=Buffer.from(makeDng())
  await page.locator('#files').setInputFiles({name:'sensor.dng',mimeType:'image/x-adobe-dng',buffer:raw})
  const tile=page.locator('#gallery .tile')
  await tile.waitFor()
  const initial=await run('state')
  assert.equal(initial.photos[0].metadata.Model,'Generated RGGB')
  await tile.dblclick()
  await page.locator('#stage canvas').waitFor()
  await run('edit',{key:'Exposure',value:.5})
  await run('edit',{key:'crop',value:{x:.25,y:.25,w:.5,h:.5}})
  const preset=await run('preset-save',{name:'Half stop'})
  assert.deepEqual(preset.edit,{Exposure:.5})
  await run('keywords',{value:'water & light, clouds'})
  await run('rate',{value:3})
  const bytes=await page.evaluate(async()=>{
    const {blob}=await window.openlr.run('export',{format:'original-settings'})
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  const files=unzipSync(Uint8Array.from(bytes))
  assert.deepEqual(Buffer.from(files['sensor.dng']),raw)
  const xml=strFromU8(files['sensor.xmp'])
  assert.ok(xml.includes('water &amp; light'))
  await run('reset');await run('rate',{value:0})
  const restored=await run('apply-xmp',{xml})
  assert.deepEqual(restored.photos[0].edit,{Exposure:.5,crop:{x:.25,y:.25,w:.5,h:.5}})
  assert.equal(restored.photos[0].rating,3)
  const width=await page.evaluate(async()=>{
    const {blob}=await window.openlr.run('export',{format:'image/png',maxSize:31,watermark:'OpenLR'})
    const image=await createImageBitmap(blob);const w=image.width;image.close();return w
  })
  assert.equal(width,31)
  await page.reload();await tile.waitFor()
  assert.ok((await run('presets')).some(p=>p.id===preset.id))
  await run('reset')
  await run('preset-apply',{id:preset.id})
  assert.deepEqual((await run('state')).photos[0].edit,{Exposure:.5})
})
