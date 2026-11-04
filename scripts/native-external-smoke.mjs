import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,readFile,writeFile,access,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {execute,parse} from '../cli/openlr.mjs'
import {makeDng} from '../tests/fixtures/dng.mjs'

const executable=process.argv[2],editor=process.argv[3]
if(!executable||!editor)throw Error('Pass the built OpenLR executable and controlled test editor executable')
const root=await mkdtemp(path.join(tmpdir(),'openlr-external-')),session=path.join(root,'agent.json')
const host=spawn(path.resolve(executable),[],{windowsHide:true,env:{...process.env,OPENLR_AGENT_FILE:session,OPENLR_EXTERNAL_FILE:path.join(root,'external.json'),OPENLR_EXTERNAL_EDITOR:path.resolve(editor),
  WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview2'),XDG_CONFIG_HOME:root,XDG_DATA_HOME:root,XDG_CACHE_HOME:root},stdio:'inherit'})
const exited=new Promise(resolve=>host.once('exit',resolve))
const call=(...args)=>execute(parse([...args,'--session',session]))
try{
  const end=Date.now()+45000
  for(;;){try{await access(session);break}catch{}if(host.exitCode!==null)throw Error('Desktop exited');if(Date.now()>end)throw Error('No desktop session');await delay(120)}
  const original=Buffer.from(makeDng()),input=path.join(root,'sensor.dng');await writeFile(input,original)
  const imported=await call('import',input),sourceId=imported.added[0]
  assert.equal(imported.failed.length,0)
  await call('edit','--key','Exposure','--value','.5')
  const sent=await call('external-edit');assert.equal(sent.sourceId,sourceId);assert.equal(sent.format,'image/tiff')
  let derived
  for(let attempt=0;attempt<30;attempt++){
    await delay(600);await call('external-check')
    derived=(await call('state')).photos.find(photo=>photo.derivedFrom===sourceId)
    if(derived)break
  }
  assert.ok(derived,'saved editor copy must return as a distinct photo')
  assert.notEqual(derived.id,sourceId);assert.equal(derived.externalSession,sent.id)
  const returned=await call('export','--format','original','--output',path.join(root,'returned.tif'))
  const bytes=await readFile(returned.path)
  assert.ok(bytes.length>100);assert.ok(['II','MM'].includes(bytes.subarray(0,2).toString()))
  assert.deepEqual(await readFile(input),original)
  await call('external-check')
  assert.equal((await call('state')).photos.filter(photo=>photo.derivedFrom===sourceId).length,1,'same saved revision must not import twice')
  const source=(await call('state')).photos.find(photo=>photo.id===sourceId)
  assert.equal(source.edit.Exposure,.5)
  console.log('Native external-editor passed edited TIFF generation, real process launch, two filesystem saves, stable snapshot return, derived-photo import, deduplication, and unchanged source DNG.')
}finally{
  host.kill();await Promise.race([exited,delay(3000)])
  await rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:200})
}
