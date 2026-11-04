import {run,commands} from './app.js'
import {schema,searchCommands,validateArgs} from './agent-protocol.js'

async function encode(blob){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader()
    reader.onload=()=>resolve(String(reader.result).split(',')[1])
    reader.onerror=()=>reject(reader.error??new Error('Cannot read image result'))
    reader.readAsDataURL(blob)
  })
}

function decodeFile(file){
  if(!file||typeof file.name!=='string'||typeof file.base64!=='string')throw new Error('Invalid imported file payload')
  const raw=atob(file.base64),bytes=new Uint8Array(raw.length)
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i)
  return new File([bytes],file.name,{type:file.type||'application/octet-stream',lastModified:file.lastModified||Date.now()})
}

// All GUI and agent mutations use app.run's same serialized, persisted command queue.
export async function dispatch(command,args={}){
  try{
    validateArgs(command,args)
    if(command==='import')args={...args,files:args.files.map(file=>file instanceof File?file:decodeFile(file))}
    const result=await run(command,args)
    if(result?.blob instanceof Blob){
      return {ok:true,result:{kind:'file',filename:result.filename,mimeType:result.blob.type||'application/octet-stream',bytes:result.blob.size,base64:await encode(result.blob)}}
    }
    return {ok:true,result}
  }catch(error){
    return {ok:false,error:{code:'COMMAND_FAILED',message:error.message||String(error)}}
  }
}

globalThis.openlr=Object.freeze({run,commands,schema,search:searchCommands,dispatch})
document.documentElement.dataset.agent='browser-ready'

async function serveNative(){
  const call=(...args)=>globalThis.mygo.call(...args)
  for(;;){
    try{
      document.documentElement.dataset.agent='connected'
      const request=await call('Desktop.AgentPoll')
      if(!request)continue
      const reply=await dispatch(request.command,request.args??{})
      await call('Desktop.AgentReply',request.id,JSON.stringify(reply))
    }catch(error){
      document.documentElement.dataset.agent='disconnected'
      console.error('OpenLR agent bridge:',error)
      await new Promise(resolve=>setTimeout(resolve,1000))
    }
  }
}

if(globalThis.mygo?.call)serveNative()
