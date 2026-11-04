import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,readFile,writeFile,mkdir,access,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {execute,parse} from '../cli/openlr.mjs'
import {makeDng} from '../tests/fixtures/dng.mjs'

const executable=process.argv[2]
if(!executable)throw Error('Pass the path to a built OpenLR executable')
const directory=await mkdtemp(path.join(tmpdir(),'openlr-native-local-'))
const photos=path.join(directory,'photos'),session=path.join(directory,'agent.json'),registry=path.join(directory,'folders.json')
await mkdir(photos);await mkdir(path.join(photos,'subfolder'))
const original=Buffer.from(makeDng()),image=path.join(photos,'sensor #1.dng')
await writeFile(image,original)
// The harness grants only its generated fixture folder. It does not bypass the
// production chooser or grant access to a user's photographs.
await writeFile(registry,JSON.stringify([{id:'fixture-root',name:'Local fixture',path:photos}]))
let host,exited
const launch=async()=>{
  host=spawn(path.resolve(executable),[],{windowsHide:true,env:{...process.env,OPENLR_AGENT_FILE:session,OPENLR_LOCAL_FILE:registry,
    WEBVIEW2_USER_DATA_FOLDER:path.join(directory,'webview2'),XDG_CONFIG_HOME:directory,XDG_DATA_HOME:directory,XDG_CACHE_HOME:directory},stdio:'inherit'})
  exited=new Promise(resolve=>host.once('exit',resolve))
  const end=Date.now()+45000
  for(;;){
    if(host.exitCode!==null||host.signalCode)throw Error('Host exited before agent connected')
    try{await access(session);break}catch{}
    if(Date.now()>end)throw Error('No agent session after 45 seconds')
    await delay(120)
  }
}
const stop=async()=>{if(host){host.kill();await Promise.race([exited,delay(3000)]);host=null;await rm(session,{force:true})}}
const call=(...args)=>execute(parse([...args,'--session',session]))
try{
  await launch()
  assert.equal((await call('local-folders'))[0].id,'fixture-root')
  const opened=await call('local-open','--root','fixture-root')
  assert.equal(opened.photos,1);assert.equal(opened.warnings.length,0)
  await call('view','--mode','detail')
  await call('edit','--key','Exposure','--value','.5')
  await call('edit','--key','turn','--value','1')
  await call('rate','--value','4')
  const sidecar=JSON.parse(await readFile(image+'.openlr.json','utf8'))
  assert.equal(sidecar.recipe.edit.Exposure,.5);assert.equal(sidecar.recipe.rating,4)
  assert.deepEqual(await readFile(image),original)
  const preview=await call('preview','--output',path.join(directory,'preview.png'))
  const png=await readFile(preview.path)
  assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[96,128])
  const exported=await call('export','--format','original','--output',path.join(directory,'copy.dng'))
  assert.deepEqual(await readFile(exported.path),original)
  await call('local-browse','--relative','subfolder')
  assert.equal((await call('state')).photos.length,0)
  await stop();await launch()
  await call('local-open','--root','fixture-root')
  const reopened=await call('state')
  assert.equal(reopened.photos[0].rating,4);assert.equal(reopened.photos[0].edit.turn,1)
  assert.equal(reopened.local.root.id,'fixture-root')
  await call('library')
  const library=await call('state')
  assert.equal(library.local,null);assert.equal(library.photos.length,0)
  console.log('Native Local passed fixture folder browsing, DNG read, sidecar edits, original preservation, preview/export, restart/reopen, and zero catalog imports. Folder permission was seeded by the test harness; the system chooser was not automated.')
}finally{
  await stop()
  await rm(directory,{recursive:true,force:true,maxRetries:6,retryDelay:200})
}
