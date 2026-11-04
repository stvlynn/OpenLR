import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,readFile,writeFile,mkdir,access,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {execute,parse} from '../cli/openlr.mjs'
import {makeDng} from '../tests/fixtures/dng.mjs'

const executable=process.argv[2]
if(!executable)throw Error('Pass the built OpenLR executable')
const root=await mkdtemp(path.join(tmpdir(),'openlr-camera-')),session=path.join(root,'agent.json'),fixtures=path.join(root,'simulator')
await mkdir(fixtures);const bytes=Buffer.from(makeDng());await writeFile(path.join(fixtures,'camera-fixture.dng'),bytes)
const host=spawn(path.resolve(executable),[],{windowsHide:true,env:{...process.env,OPENLR_AGENT_FILE:session,OPENLR_CAMERA_DIRECTORY:path.join(root,'captures'),OPENLR_CAMERA_SIMULATOR:fixtures,OPENLR_EXTERNAL_FILE:path.join(root,'external.json'),
  WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview2'),XDG_CONFIG_HOME:root,XDG_DATA_HOME:root,XDG_CACHE_HOME:root},stdio:'inherit'})
const exited=new Promise(resolve=>host.once('exit',resolve));const call=(...args)=>execute(parse([...args,'--session',session]))
try{
  const end=Date.now()+45000
  for(;;){try{await access(session);break}catch{}if(host.exitCode!==null)throw Error('Desktop exited');if(Date.now()>end)throw Error('No desktop session');await delay(120)}
  const discovery=await call('camera-list'),simulator=discovery.devices.find(camera=>camera.id==='simulator')
  assert.equal(simulator.simulated,true);assert.match(simulator.name,/SIMULATOR/)
  await call('tether')
  const shot=await call('camera-capture','--id','simulator')
  assert.equal(shot.added.length,1);assert.equal(shot.failed.length,0);assert.equal(shot.device.simulated,true)
  const state=await call('state'),photo=state.photos.find(photo=>photo.id===shot.added[0])
  assert.equal(photo.cameraCapture.simulated,true)
  const exported=await call('export','--format','original','--output',path.join(root,'returned.dng'))
  assert.deepEqual(await readFile(exported.path),bytes);assert.deepEqual(await readFile(path.join(fixtures,'camera-fixture.dng')),bytes)
  const output=path.resolve('.workspace/native-final');await mkdir(output,{recursive:true})
  await call('screenshot','--output',path.join(output,'camera-simulator.png'),'--force')
  await writeFile(path.join(output,'camera-report.json'),JSON.stringify({discovery,shot,physicalCameraValidated:false},null,2))
  console.log('Native tethered-capture SIMULATOR contract passed: discovery label, actual file download, shared catalog import, DNG original export, unchanged source and GUI screenshot. No physical camera capture was tested.')
}finally{host.kill();await Promise.race([exited,delay(3000)]);await rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:200})}
