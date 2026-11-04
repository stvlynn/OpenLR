import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,readFile,writeFile,mkdir,access,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {execute,parse} from '../cli/openlr.mjs'
import {frame,png} from '../tests/fixtures/merge-scene.js'

const executable=process.argv[2]
if(!executable)throw Error('Pass the built OpenLR executable')
const root=await mkdtemp(path.join(tmpdir(),'openlr-integration-')),session=path.join(root,'agent.json')
const output=path.resolve('.workspace/native-final');await mkdir(output,{recursive:true})
const host=spawn(path.resolve(executable),[],{windowsHide:true,env:{...process.env,OPENLR_AGENT_FILE:session,OPENLR_EXTERNAL_FILE:path.join(root,'external.json'),OPENLR_LOCAL_FILE:path.join(root,'folders.json'),
  WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview2'),XDG_CONFIG_HOME:root,XDG_DATA_HOME:root,XDG_CACHE_HOME:root},stdio:'inherit'})
const exited=new Promise(resolve=>host.once('exit',resolve))
const call=(...args)=>execute(parse([...args,'--session',session]))
const report={platform:process.platform,checks:[]}
try{
  const end=Date.now()+45000
  for(;;){try{await access(session);break}catch{}if(host.exitCode!==null)throw Error('Desktop exited');if(Date.now()>end)throw Error('No desktop session');await delay(120)}
  const paths=[]
  for(const [index,offset]of [{x:0,y:0},{x:180,y:7},{x:360,y:-4}].entries()){
    const file=path.join(root,`panorama-${index}.png`);await writeFile(file,png(frame(360,260,offset)));paths.push(file)
  }
  const panoramaSources=await call('import',...paths);assert.equal(panoramaSources.failed.length,0)
  const panorama=await call('merge-panorama','--ids',JSON.stringify(panoramaSources.added))
  assert.ok(panorama.width>500&&panorama.height>150)
  await call('export','--format','image/png','--output',path.join(output,'panorama.png'),'--force')
  report.checks.push({name:'panorama',result:panorama})
  paths.length=0
  for(const [index,options]of [{hdr:true,ev:-2,x:5,y:-3},{hdr:true,ev:0,x:0,y:0},{hdr:true,ev:2,x:-4,y:2}].entries()){
    const file=path.join(root,`hdr-${index}.png`);await writeFile(file,png(frame(600,260,options)));paths.push(file)
  }
  const hdrSources=await call('import',...paths);assert.equal(hdrSources.failed.length,0)
  const hdr=await call('merge-hdr','--ids',JSON.stringify(hdrSources.added),'--evs','[-2,0,2]')
  const radiance=await call('export-hdr','--output',path.join(output,'merged.hdr'),'--force')
  assert.match((await readFile(radiance.path)).subarray(0,80).toString(),/#\?RADIANCE/)
  report.checks.push({name:'hdr',result:hdr})
  const crw=path.resolve('tests/fixtures/raw/canon-powershot-g1.crw')
  const before=await readFile(crw),raw=await call('import',crw);assert.equal(raw.failed.length,0)
  const dng=await call('export','--format','image/x-adobe-dng','--output',path.join(output,'canon-linear.dng'),'--force')
  assert.ok(dng.bytes>10_000_000);assert.deepEqual(await readFile(crw),before)
  report.checks.push({name:'real-crw-to-linear-dng',bytes:dng.bytes})
  const aiPhoto=await call('import',path.resolve('tests/fixtures/ai/astronaut.png'));assert.equal(aiPhoto.failed.length,0)
  await call('view','--mode','detail')
  for(const target of ['person','subject']){
    const mask=await call('ai-mask','--target',target)
    const state=await call('state'),photo=state.photos.find(photo=>photo.id===state.selected)
    assert.ok(photo.edit.localTools?.masks.some(mask=>mask.provenance?.target===target))
    report.checks.push({name:'ai-'+target,result:mask})
  }
  const screenshot=await call('screenshot','--output',path.join(output,'workspace.png'),'--force')
  const image=await readFile(screenshot.path);assert.deepEqual([...image.subarray(0,8)],[137,80,78,71,13,10,26,10])
  report.checks.push({name:'workspace-screenshot',bytes:screenshot.bytes})
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2))
  console.log('Native integrated smoke passed panorama, HDR/radiance, real Canon CRW to linear DNG, person/subject model inference, and workspace screenshot. Artifacts: '+output)
}finally{
  host.kill();await Promise.race([exited,delay(3000)])
  await rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:200})
}
