import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright-core'
import {serveWorkspace} from './browser-server.mjs'

test('calibrated profile UI, manual geometry, local tools and straightening share original coordinates and persist through XMP',async t=>{
  const server=await serveWorkspace();t.after(server.close)
  const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true});t.after(()=>browser.close())
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(server.url);await page.waitForFunction(()=>window.openlr)
  const run=(command,args={})=>page.evaluate(({command,args})=>window.openlr.run(command,args),{command,args})
  await page.locator('#files').setInputFiles({name:'canon-powershot-g1.crw',mimeType:'image/x-canon-crw',buffer:await readFile(new URL('./fixtures/raw/canon-powershot-g1.crw',import.meta.url))})
  await page.waitForFunction(()=>document.querySelectorAll('#gallery .tile').length===1)
  await run('view',{mode:'detail'})
  const before=await page.evaluate(async()=>{const {blob}=await window.openlr.run('preview',{maxSize:200});return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())))})
  const candidates=await run('lens-match')
  // exifr does not expose this older CIFF container's camera tags. The UI must
  // offer no invented match; use the verified public EXIF report for this sample.
  assert.equal(candidates.profiles.length,0)
  assert.equal((await run('state')).photos[0].edit.optics,undefined)
  await page.locator('#optics-panel summary').click()
  await page.getByRole('button',{name:'Match EXIF',exact:true}).click()
  const profiles=await run('lens-profiles',{query:'PowerShot G1'})
  const chosen=profiles.find(profile=>profile.model==='Canon PowerShot G1 & compatibles (Standard)')
  await page.getByLabel('Search lens profiles',{exact:true}).fill('PowerShot G1')
  await page.getByLabel('Lens profile',{exact:true}).selectOption(chosen.id)
  await page.getByLabel('Lens focal length',{exact:true}).fill('14.6')
  await page.getByLabel('Camera crop factor',{exact:true}).fill('4.843')
  await page.getByRole('button',{name:'Apply profile',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('#optics-panel .tool-hint').textContent.includes('CC BY-SA'))
  let state=await run('state'),profile=state.photos.find(photo=>photo.id===state.selected).edit.optics.profile
  assert.equal(profile.id,chosen.id)
  assert.equal(profile.focal,14.6)
  assert.equal(profile.cropFactor,4.843)
  const after=await page.evaluate(async()=>{const {blob}=await window.openlr.run('preview',{maxSize:200});return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())))})
  assert.notDeepEqual(after,before)
  const profileXmp=await page.evaluate(async()=>{const {blob}=await window.openlr.run('export',{format:'application/rdf+xml'});return blob.text()})
  await run('optics-reset');await run('apply-xmp',{xml:profileXmp})
  state=await run('state');assert.equal(state.photos.find(photo=>photo.id===state.selected).edit.optics.profile.sourceCommit,profile.sourceCommit)
  const synthetic=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=300;canvas.height=200
    const ctx=canvas.getContext('2d');ctx.fillStyle='#646464';ctx.fillRect(0,0,300,200);ctx.strokeStyle='#fff';ctx.lineWidth=1
    for(let x=30;x<300;x+=30){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,200);ctx.stroke()}
    return canvas.toDataURL().split(',')[1]
  })
  await page.locator('#files').setInputFiles({name:'line-grid.png',mimeType:'image/png',buffer:Buffer.from(synthetic,'base64')})
  await page.waitForFunction(()=>document.querySelectorAll('#gallery .tile').length===2)
  await run('view',{mode:'detail'})
  await run('optics',{changes:{manualDistortion:-30,vertical:8,rotate:13,scale:120}})
  await run('edit',{key:'crop',value:{x:0.1,y:0.1,w:0.8,h:0.8}})
  await run('edit',{key:'turn',value:1});await run('edit',{key:'flip',value:true})
  const expected=await page.evaluate(async()=>{
    const state=await window.openlr.run('state'),photo=state.photos.find(photo=>photo.id===state.selected),{viewToOriginal}=await import('./local-tools-ui.js')
    return viewToOriginal({x:0.4,y:0.6},photo,photo.edit)
  })
  await run('local-tool',{tool:'brush'})
  let box=await page.locator('#stage canvas').boundingBox()
  await page.mouse.move(box.x+box.width*0.4,box.y+box.height*0.6);await page.mouse.down()
  await page.mouse.move(box.x+box.width*0.5,box.y+box.height*0.6,{steps:4});await page.mouse.up()
  state=await run('state');let photo=state.photos.find(photo=>photo.id===state.selected),point=photo.edit.localTools.masks[0].points[0]
  assert.ok(Math.hypot(point.x-expected.x,point.y-expected.y)<0.006)
  await run('straighten-tool',{axis:'horizontal'})
  const reference=await page.evaluate(async()=>{
    const state=await window.openlr.run('state'),photo=state.photos.find(photo=>photo.id===state.selected),{viewToOriginal}=await import('./local-tools-ui.js')
    return [viewToOriginal({x:0.3,y:0.4},photo,photo.edit),viewToOriginal({x:0.7,y:0.6},photo,photo.edit)]
  })
  box=await page.locator('#stage canvas').boundingBox()
  await page.mouse.click(box.x+box.width*0.3,box.y+box.height*0.4)
  await page.mouse.click(box.x+box.width*0.7,box.y+box.height*0.6)
  state=await run('state');photo=state.photos.find(photo=>photo.id===state.selected)
  const projected=await page.evaluate(async reference=>{
    const state=await window.openlr.run('state'),photo=state.photos.find(photo=>photo.id===state.selected),{originalToView}=await import('./local-tools-ui.js')
    return reference.map(point=>originalToView(point,photo,photo.edit))
  },reference)
  assert.ok(Math.abs(projected[0].y-projected[1].y)<0.006)
  assert.equal(state.zoom,false)
  const xml=await page.evaluate(async()=>{const {blob}=await window.openlr.run('export',{format:'application/rdf+xml'});return blob.text()})
  const saved=photo.edit.optics
  await run('optics-reset');await run('apply-xmp',{xml})
  assert.deepEqual((await run('state')).photos.find(item=>item.id===photo.id)?.edit.optics,saved)
  const failure=await page.evaluate(()=>window.openlr.dispatch('optics',{changes:{scale:0}}))
  assert.equal(failure.ok,false)
  const id=photo.id;await page.reload();await page.waitForFunction(()=>window.openlr)
  state=await run('state');photo=state.photos.find(photo=>photo.id===id)
  assert.deepEqual(photo.edit.optics,saved)
  assert.ok(photo.edit.localTools.masks.length===1)
  assert.deepEqual(errors,[])
})
