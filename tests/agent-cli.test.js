import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {parse,execute} from '../cli/openlr.mjs'

test('offline discovery and dry runs validate real command arguments',async()=>{
  assert.ok(parse(['cli','search','exposure']).local.some(result=>result.command==='edit'))
  assert.equal(parse(['schema','export']).local.parameters.properties.format.enum[1],'image/png')
  assert.deepEqual((await execute(parse(['edit','--key','Exposure','--value','0.5','--dry-run']))).request,{command:'edit',args:{key:'Exposure',value:0.5}})
  assert.equal(parse(['edit','--key','aspect','--value','1.5','--dry-run']).args.value,'1.5')
  assert.equal(parse(['edit','--key','flip','--value','true']).args.value,true)
  assert.throws(()=>parse(['rate','--value','2.5']),/integer/)
  assert.throws(()=>parse(['edit','--key','Exposure','--value','6']),/between/)
  assert.throws(()=>parse(['select']),/Missing argument/)
  assert.throws(()=>parse(['state','--unexpected','true']),/Unknown option/)
})

test('CLI uses the authenticated live transport, moves file bytes, and protects outputs',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'openlr-agent-test-'))
  t.after(()=>rm(directory,{recursive:true,force:true}))
  const image=Buffer.from([137,80,78,71,13,10,26,10])
  const received=[]
  const server=createServer(async(req,res)=>{
    assert.equal(req.url,'/command')
    assert.equal(req.headers.authorization,'Bearer test-session-token')
    const chunks=[]
    for await(const chunk of req)chunks.push(chunk)
    const request=JSON.parse(Buffer.concat(chunks))
    received.push(request)
    let result
    if(request.command==='preview')result={kind:'file',filename:'current.png',mimeType:'image/png',bytes:image.length,base64:image.toString('base64')}
    else result={selected:'live-photo',photos:[],imported:request.args.files?.length}
    res.setHeader('Content-Type','application/json')
    res.end(JSON.stringify({ok:true,result}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const session=path.join(directory,'agent.json')
  await writeFile(session,JSON.stringify({url:'http://127.0.0.1:'+server.address().port,token:'test-session-token',version:1,pid:process.pid}))
  const state=await execute(parse(['state','--session',session]))
  assert.equal(state.selected,'live-photo')
  const input=path.join(directory,'source.png')
  await writeFile(input,image)
  const imported=await execute(parse(['import',input,'--session',session]))
  assert.equal(imported.imported,1)
  assert.equal(received[1].args.files[0].base64,image.toString('base64'))
  assert.equal(received[1].args.files[0].type,'image/png')
  const output=path.join(directory,'preview.png')
  const previewRequest=parse(['preview','--output',output,'--session',session])
  assert.equal((await execute(previewRequest)).path,output)
  assert.deepEqual(await readFile(output),image)
  await assert.rejects(execute(previewRequest),/EEXIST/)
  await execute({...previewRequest,force:true})
})

test('transport failures remain failures, without inventing local GUI state',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'openlr-agent-failure-'))
  t.after(()=>rm(directory,{recursive:true,force:true}))
  const session=path.join(directory,'agent.json')
  await writeFile(session,JSON.stringify({url:'https://example.com',token:'test',version:1}))
  await assert.rejects(execute(parse(['state','--session',session])),/Invalid local/)
  await assert.rejects(execute(parse(['state','--session',path.join(directory,'missing.json')])),/Start OpenLR first/)
})
