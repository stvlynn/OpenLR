import {run,commands} from './app.js'
import {schema,searchCommands,validateArgs} from './agent-protocol.js'

import {decodeFile,encodeBlob} from './transfer.js'

// All GUI and agent mutations use app.run's same serialized, persisted command queue.
export async function dispatch(command,args={},capture=false){
  try{
    validateArgs(command,args)
    if(command==='import')args={...args,files:args.files.map(file=>file instanceof File?file:decodeFile(file))}
    if(command==='screenshot'||capture){
      if(!globalThis.mygo?.call)throw Error('Workspace capture requires the desktop app')
      return await run(command==='screenshot'?'state':command,args,async(result,state)=>{
        if(result?.blob)throw Error('Use screenshot separately from image export')
        await new Promise(resolve=>setTimeout(resolve,32))
        const base64=await globalThis.mygo.call('Desktop.CaptureWorkspace')
        const frame={kind:'file',filename:'workspace.png',mimeType:'image/png',bytes:Math.floor(base64.length*3/4)-(base64.endsWith('==')?2:base64.endsWith('=')?1:0),base64}
        return command==='screenshot'?{ok:true,result:frame}:{ok:true,result,frame,selected:state.selected}
      })
    }
    const result=await run(command,args)
    if(result?.blob instanceof Blob){
      return {ok:true,result:{kind:'file',filename:result.filename,mimeType:result.blob.type||'application/octet-stream',bytes:result.blob.size,base64:await encodeBlob(result.blob)}}
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
      const reply=await dispatch(request.command,request.args??{},request.capture)
      await call('Desktop.AgentReply',request.id,JSON.stringify(reply))
    }catch(error){
      document.documentElement.dataset.agent='disconnected'
      console.error('OpenLR agent bridge:',error)
      await new Promise(resolve=>setTimeout(resolve,1000))
    }
  }
}

if(globalThis.mygo?.call){
  serveNative()
  if(globalThis.mygo.on)window.addEventListener('openlr-change',()=>globalThis.mygo.call('Desktop.AgentChanged').catch(error=>console.error(error)))
  globalThis.mygo.on?.('workspaceMenu',async id=>{
    try{
      if(id==='choose-photos')document.getElementById('import').click()
      else if(id==='export-dialog')document.getElementById('export').click()
      else if(['new-album','grid','detail'].includes(id))document.getElementById(id).click()
      else await run(id)
    }catch(error){document.getElementById('notice').textContent=error.message}
  })
}
