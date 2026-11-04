import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright-core'
import {validateLocalTool,applyLocalTools,updateLocalTools,localWeight} from '../web/local-tools.js'
import {parse} from '../cli/openlr.mjs'

test('range coverage uses source RGB/linear luminance and composites apply one adjustment',()=>{
  const color=validateLocalTool('mask',{type:'color-range',color:'#1464b4',tolerance:0,softness:0.1,adjustments:{Exposure:1}})
  assert.equal(localWeight(color,.5,.5,1,1,[20,100,180]),1);assert.equal(localWeight(color,.5,.5,1,1,[180,180,20]),0)
  const lum=validateLocalTool('mask',{type:'luminance-range',min:.4,max:1,softness:0,adjustments:{Exposure:1}})
  const source=()=>({width:2,height:1,data:Uint8ClampedArray.from([20,100,180,255,180,180,20,255])}),a=source()
  applyLocalTools(a,{masks:[color]});assert.ok(a.data[0]>20);assert.equal(a.data[4],180)
  const b=source();applyLocalTools(b,{masks:[lum]});assert.equal(b.data[0],20);assert.ok(b.data[4]>180)
  for(const operation of ['add','subtract','intersect']){
    const base={localTools:{masks:[{...color,id:'a'},{...lum,id:'b'}],repairs:[]}},edit=updateLocalTools(base,'mask.combine',{id:'a',operandId:'b',operation})
    assert.equal(edit.localTools.masks.length,1);assert.equal(edit.localTools.masks[0].id,'a');assert.equal(edit.localTools.masks[0].components.length,2)
    const output=source();applyLocalTools(output,edit.localTools)
    assert.equal(output.data[0]>20,operation!=='intersect');assert.equal(output.data[4]>180,operation==='add')
    const changed=updateLocalTools(edit,'mask.component-update',{id:'a',path:[1],changes:{min:.1}})
    assert.equal(changed.localTools.masks[0].components[1].min,.1)
    assert.equal(edit.localTools.masks[0].components[1].min,.4)
  }
  assert.throws(()=>validateLocalTool('mask',{type:'luminance-range',min:.8,max:.2}),/minimum/)
  assert.throws(()=>validateLocalTool('mask',{type:'color-range',color:'blue'}),/RRGGBB/)
  assert.equal(parse(['mask.combine','--id','a','--operandId','b','--operation','subtract','--dry-run']).args.operation,'subtract')
})

test('UI creates range masks, combines them, persists and exports actual pixels',async t=>{
  const server=createServer(async(req,res)=>{try{const file=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';if(file.includes('..'))throw Error();res.setHeader('Content-Type',/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(new URL('../web/'+file,import.meta.url)))}catch{res.writeHead(404).end()}})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()})
  const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1400,height:1000}})
  await page.goto('http://127.0.0.1:'+server.address().port)
  await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=160;c.height=80;const ctx=c.getContext('2d');ctx.fillStyle='#1464b4';ctx.fillRect(0,0,80,80);ctx.fillStyle='#b4b414';ctx.fillRect(80,0,80,80);const {run}=await import('./app.js');await run('import',{files:[new File([await new Promise(resolve=>c.toBlob(resolve))],'ranges.png',{type:'image/png'})]});await run('view',{mode:'detail'})})
  await page.getByText('Masks & local repair',{exact:true}).click();await page.getByLabel('Range color',{exact:true}).fill('#1464b4');await page.getByLabel('Range tolerance',{exact:true}).fill('0');await page.getByLabel('Range softness',{exact:true}).fill('0');await page.getByRole('button',{name:'Create color range',exact:true}).click()
  await page.waitForFunction(async()=>((await import('./app.js')).run('state')).then(s=>s.photos[0].edit.localTools?.masks.length===1))
  await page.getByLabel('Local edit selection',{exact:true}).selectOption('');await page.getByLabel('Range minimum',{exact:true}).fill('0.4');await page.getByLabel('Range maximum',{exact:true}).fill('1');await page.getByRole('button',{name:'Create luminance range',exact:true}).click()
  await page.waitForFunction(async()=>((await import('./app.js')).run('state')).then(s=>s.photos[0].edit.localTools?.masks.length===2))
  const ids=await page.evaluate(async()=>((await import('./app.js')).run('state')).then(s=>s.photos[0].edit.localTools.masks.map(mask=>mask.id)))
  await page.getByLabel('Local edit selection',{exact:true}).selectOption(ids[0]);await page.getByLabel('Combine with mask',{exact:true}).selectOption(ids[1]);await page.getByRole('button',{name:'Subtract mask',exact:true}).click()
  await page.waitForFunction(async()=>((await import('./app.js')).run('state')).then(s=>s.photos[0].edit.localTools?.masks.length===1))
  const pixels=await page.evaluate(async()=>{const {run}=await import('./app.js');await run('edit',{key:'crop',value:{x:0,y:0,w:.75,h:1}});await run('edit',{key:'turn',value:1});const out=await run('export',{format:'image/png'}),bitmap=await createImageBitmap(out.blob),c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();return {width:c.width,height:c.height,blue:[...ctx.getImageData(40,20,1,1).data],yellow:[...ctx.getImageData(40,100,1,1).data]}})
  assert.equal(pixels.width,80);assert.equal(pixels.height,120);assert.ok(pixels.blue[2]>180);assert.deepEqual(pixels.yellow,[180,180,20,255])
  await page.getByLabel('Mask component',{exact:true}).selectOption('1');await page.getByLabel('Range minimum',{exact:true}).fill('0.5');await page.getByLabel('Range minimum',{exact:true}).press('Tab')
  await page.waitForFunction(async()=>((await import('./app.js')).run('state')).then(s=>s.photos[0].edit.localTools.masks[0].components[1].min===.5))
  await page.reload();await page.locator('#gallery .tile').waitFor();const kind=await page.evaluate(async()=>((await import('./app.js')).run('state')).then(s=>s.photos[0].edit.localTools.masks[0].type));assert.equal(kind,'composite')
})
