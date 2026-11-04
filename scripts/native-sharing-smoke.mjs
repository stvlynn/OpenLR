import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,readFile,writeFile,mkdir,access,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {chromium} from 'playwright-core'
import {execute,parse} from '../cli/openlr.mjs'
import {frame,png} from '../tests/fixtures/merge-scene.js'

const executable=process.argv[2],service=process.argv[3]
if(!executable||!service)throw Error('Pass the native OpenLR and independent openlr-share executables')
const root=await mkdtemp(path.join(tmpdir(),'openlr-sharing-')),session=path.join(root,'agent.json'),descriptor=path.join(root,'review-server.json')
const processes=[]
const launch=(file,args,env={})=>{const process=spawn(path.resolve(file),args,{windowsHide:true,env:{...globalThis.process.env,...env},stdio:'inherit'});processes.push(process);return process}
const waitFor=async file=>{const end=Date.now()+45000;for(;;){try{await access(file);return}catch{}if(Date.now()>end)throw Error('Timed out waiting for '+path.basename(file));await delay(120)}}
let browser
try{
  launch(service,['-addr','127.0.0.1:0','-data',path.join(root,'review-data'),'-session',descriptor]);await waitFor(descriptor)
  const config=JSON.parse(await readFile(descriptor,'utf8'))
  launch(executable,[],{OPENLR_AGENT_FILE:session,OPENLR_SHARE_FILE:path.join(root,'sharing.json'),OPENLR_SHARE_URL:config.url,OPENLR_SHARE_TOKEN:config.adminToken,OPENLR_EXTERNAL_FILE:path.join(root,'external.json'),WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview2'),XDG_CONFIG_HOME:root,XDG_DATA_HOME:root,XDG_CACHE_HOME:root})
  await waitFor(session)
  const call=(...args)=>execute(parse([...args,'--session',session]))
  const image=path.join(root,'generated-scene.png'),original=png(frame(240,180))
  await writeFile(image,original);await call('import',image);await call('edit','--key','Exposure','--value','.5')
  const album=await call('album','--name','Review fixture');await call('membership','--album',album.id);await call('scope','--id',album.id)
  const shared=await call('share-publish');assert.equal(shared.photos,1);assert.ok(shared.url.startsWith('http://127.0.0.1:'))
  browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true});const page=await browser.newPage()
  await page.goto(shared.url);await page.getByRole('heading',{name:'Review fixture',exact:true}).waitFor()
  await page.waitForFunction(()=>document.querySelector('article img')?.naturalWidth>0)
  await page.getByLabel('Your name').fill('Generated-fixture reviewer')
  await page.getByRole('button',{name:'Like',exact:true}).click();await page.getByRole('button',{name:'Unlike',exact:true}).waitFor()
  await page.getByRole('textbox',{name:'Comment on generated-scene.png'}).fill('Prefer this edited version')
  await page.getByRole('button',{name:'Post comment',exact:true}).click();await page.getByText('Generated-fixture reviewer: Prefer this edited version',{exact:true}).waitFor()
  const reviews=await call('share-reviews');assert.equal(reviews.comments.length,1);assert.equal(Object.values(reviews.likes)[0]&&Object.keys(Object.values(reviews.likes)[0]).length,1)
  const denied=await fetch(shared.url.replace(/\?key=.*/,''));assert.equal(denied.status,200,'unauthorized page may serve only the empty viewer shell')
  const api=new URL(shared.url);api.pathname='/review/'+album.id;api.search='';assert.equal((await fetch(api)).status,403)
  await call('share-revoke');api.search=new URL(shared.url).search;assert.equal((await fetch(api)).status,403)
  assert.deepEqual(await readFile(image),original)
  const output=path.resolve('.workspace/native-final');await mkdir(output,{recursive:true})
  await page.screenshot({path:path.join(output,'shared-album-review.png'),fullPage:true})
  await writeFile(path.join(output,'sharing-report.json'),JSON.stringify({loopbackOnly:true,photos:shared.photos,comments:reviews.comments,likes:reviews.likes,revoked:true,adobeServicesUsed:false},null,2))
  console.log('Native album sharing passed loopback-only independent server, edited album publication, actual browser gallery/image, authorized comment+like, GUI/CLI review readback, denied access and link revocation. Only generated test photographs were used.')
}finally{await browser?.close();for(const process of processes.reverse())process.kill();await delay(800);await rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:200})}
