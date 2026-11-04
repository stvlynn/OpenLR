import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {chromium} from 'playwright-core'

test('import, organize, edit, export, reopen and recover a deleted photo',async(t)=>{
  const server=createServer(async(req,res)=>{
    try {
      const url = new URL(req.url,'http://localhost')
      const file = url.pathname==='/'?'index.html':url.pathname.slice(1)
      if(!/^[\w./-]+$/.test(file)||file.includes('..'))throw Error()
      const bytes=await readFile(new URL('../web/'+file,import.meta.url))
      res.setHeader('Content-Type',({'html':'text/html','js':'text/javascript','css':'text/css','wasm':'application/wasm'})[file.split('.').pop()]||'application/octet-stream')
      res.end(bytes)
    }catch{res.writeHead(404).end()}
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  t.after(()=>{server.closeAllConnections();server.close()})
  const dir=await mkdtemp(join(tmpdir(),'openlr-e2e-'))

  const options={channel:process.env.CHROME_CHANNEL||'chrome',headless:true,acceptDownloads:true}
  let context=await chromium.launchPersistentContext(dir,options)
  t.after(async()=>{ await context.close(); await rm(dir,{recursive:true,force:true,maxRetries:4}) })
  let page=context.pages()[0]
  const url='http://127.0.0.1:'+server.address().port
  await page.goto(url)
  const bytes=await page.evaluate(()=>{
    const c=document.createElement('canvas');c.width=80;c.height=60
    const g=c.getContext('2d');g.fillStyle='#666';g.fillRect(0,0,80,60)
    g.fillStyle='#048';g.fillRect(10,10,30,20)
    return c.toDataURL().split(',')[1]
  })
  const file={name:'lake.png',mimeType:'image/png',buffer:Buffer.from(bytes,'base64')}
  await page.locator('#files').setInputFiles(file)
  await page.locator('#gallery .tile').waitFor()
  await page.getByRole('button',{name:'Create album',exact:true}).click()
  await page.locator('#album-name').fill('Trip')
  await page.getByRole('button',{name:'Create',exact:true}).click()
  await page.locator('#membership').selectOption({label:'＋ Trip'})
  await page.locator('#albums button').click()
  await page.getByRole('button',{name:'Edit',exact:true}).click()
  await page.locator('#stage canvas').waitFor()
  await page.keyboard.press('4');await page.keyboard.press('z')
  const pixel=()=>page.locator('#stage canvas').evaluate(c=>c.getContext('2d').getImageData(0,0,1,1).data[0])
  assert.equal(await pixel(),102)
  await page.locator('[data-control=Exposure]').fill('1')
  await page.waitForFunction(()=>document.querySelector('#stage canvas').getContext('2d').getImageData(0,0,1,1).data[0]>130)
  await page.locator('#compare').click()
  assert.equal(await pixel(),102)
  await page.locator('#compare').click()
  await page.locator('summary').filter({hasText:'Crop & rotate'}).click()
  await page.locator('#right').click()
  await page.waitForFunction(()=>document.querySelector('#stage canvas').width===60)
  await page.locator('#export').click()
  await page.locator('#format').selectOption('image/png')
  const downloadPromise=page.waitForEvent('download')
  await page.getByRole('button',{name:'Save',exact:true}).click()
  const download=await downloadPromise
  assert.equal(download.suggestedFilename(),'lake.png')
  const output=await readFile(await download.path())
  assert.equal(output.readUInt32BE(16),60)
  assert.equal(output.readUInt32BE(20),80)
  await context.close()
  context=await chromium.launchPersistentContext(dir,options)
  page=context.pages()[0]
  await page.goto(url)
  await page.locator('#gallery .tile').waitFor()
  assert.equal(await page.locator('#rate').inputValue(),'4')
  assert.equal(await page.locator('#flag').inputValue(),'pick')
  await page.locator('#delete').click()
  await page.locator('[data-scope=trash]').click()
  await page.getByRole('button',{name:'Restore',exact:true}).click()
  await page.locator('[data-scope=all]').click()
  await page.locator('#gallery .tile').waitFor()
  const state=await page.evaluate(async()=> (await import('./app.js')).run('state'))
  assert.equal(state.photos[0].edit.Exposure,1)
  assert.equal(state.photos[0].edit.turn,1)
  assert.equal(state.albums[0].name,'Trip')
  const original=await page.evaluate(async()=>{
    const {blob}=await (await import('./app.js')).run('export',{format:'original'})
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  assert.deepEqual(Buffer.from(original),file.buffer)
})
