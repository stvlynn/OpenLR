import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,readFile,writeFile,access,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {execute,parse} from '../cli/openlr.mjs'
import {makeDng} from '../tests/fixtures/dng.mjs'

const executable=process.argv[2]
if(!executable)throw Error('Pass the path to a built OpenLR executable')
const root=await mkdtemp(path.join(tmpdir(),'openlr-native-'))
const session=path.join(root,'agent.json')
const host=spawn(path.resolve(executable),[],{env:{...process.env,OPENLR_AGENT_FILE:session,
  WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview2'),XDG_CONFIG_HOME:root,XDG_DATA_HOME:root,XDG_CACHE_HOME:root},stdio:'inherit'})
const exited=new Promise(resolve=>host.once('exit',(code,signal)=>resolve({code,signal})))
const call=(...args)=>execute(parse([...args,'--session',session]))
try{
  const end=Date.now()+45000
  for(;;){
    if(host.exitCode!==null||host.signalCode)throw Error('Host exited before agent connected')
    try{await access(session);break}catch{}
    if(Date.now()>end)throw Error('No agent session after 45 seconds')
    await delay(120)
  }
  const file=path.join(root,'sensor.dng'),data=Buffer.from(makeDng())
  await writeFile(file,data)
  const launch=await call('import',file)
  assert.deepEqual(launch.failed,[]);assert.equal(launch.added.length,1)
  await call('view','--mode','detail')
  await call('edit','--key','Exposure','--value','.5')
  await call('edit','--key','turn','--value','1')
  const {result:state,frame}=await call('rate','--value','4','--capture',path.join(root,'workspace.png'))
  const screen=await readFile(frame.path)
  assert.equal(screen.subarray(1,4).toString(),'PNG')
  assert.ok(screen.readUInt32BE(16)>128&&screen.readUInt32BE(20)>96)
  assert.equal(state.photos.find(p=>p.id===launch.added[0]).rating,4)
  const preview=await call('preview','--output',path.join(root,'preview.png'))
  const png=await readFile(preview.path)
  assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[96,128])
  const exported=await call('export','--format','original','--output',path.join(root,'original.dng'))
  assert.deepEqual(await readFile(exported.path),data)
  console.log('Native GUI/CLI passed sensor DNG import, edit, persistent command state, preview and original export.')
}finally{
  host.kill()
  await Promise.race([exited,delay(3000)])
  await rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:200})
}
