import {writeNativeExport} from './desktop.js'

const call=(name,...args)=>{
  if(!globalThis.mygo?.call)throw Error('External editors require the desktop app.')
  return globalThis.mygo.call('External.'+name,...args)
}
let button,configured=false
export async function choose(photoshop=false){
  const editor=await call(photoshop?'Photoshop':'ChooseEditor')
  if(editor)configured=true
  if(button)button.title=editor||'Choose an external image editor'
  return {editor,canceled:!editor}
}
export async function send(blob,filename,sourceId){
  const session=await call('Begin',sourceId,filename)
  await writeNativeExport(blob,session.transfer)
  await call('Launch',session.id)
  return {id:session.id,sourceId,status:'editing',format:'image/tiff'}
}
export async function changes(){
  const pending=await call('Changes'),files=[]
  for(const item of pending){
    if(item.error)throw Error(item.name+': '+item.error)
    const origin=globalThis.mygo.platform==='win32'?'http://externalphoto.localhost':'externalphoto://localhost'
    const response=await fetch(`${origin}/${item.id}/${item.hash}`)
    if(!response.ok)throw Error('Cannot read the saved external copy')
    files.push({...item,file:new File([await response.blob()],item.name,{type:'image/tiff'})})
  }
  return files
}
export const acknowledge=item=>call('Acknowledge',item.id,item.hash)
export function mount(run,report){
  const bar=document.createElement('div');bar.className='external-editor'
  const chooseButton=document.createElement('button');chooseButton.textContent='Choose external editor…'
  chooseButton.onclick=()=>run('external-editor')
  const photoshop=document.createElement('button');photoshop.textContent='Use Photoshop'
  photoshop.onclick=()=>run('external-editor',{photoshop:true})
  button=document.createElement('button');button.textContent='Edit copy externally'
  button.onclick=()=>run('external-edit')
  const check=document.createElement('button');check.textContent='Check saved copies';check.onclick=()=>run('external-check')
  for(const control of [chooseButton,photoshop,button,check])control.disabled=!globalThis.mygo?.call
  bar.append(chooseButton,photoshop,button,check);document.querySelector('aside').append(bar)
  if(globalThis.mygo?.call){
    call('Editor').then(editor=>{configured=Boolean(editor);button.title=editor||'Choose an external editor first'}).catch(error=>report(error.message))
    let busy=false
    setInterval(async()=>{
      if(busy)return
      busy=true
      try{await run('external-check')}catch(error){report(error.message)}finally{busy=false}
    },2500)
  }
}
