let dialog,select,status,captureButton,dispatch
const call=(method,...args)=>{
  if(!globalThis.mygo?.call)throw Error('Tethered capture requires the desktop app.')
  return globalThis.mygo.call('Camera.'+method,...args)
}
export async function discover(){
  const result=await call('Devices')
  if(select){
    select.replaceChildren(...result.devices.map(device=>{
      const option=new Option(device.name+' · '+device.backend,device.id);option.disabled=!device.canCapture;return option
    }))
    captureButton.disabled=!result.devices.some(device=>device.canCapture)
    status.textContent=result.devices.length?'Capture downloads a new image into Photo library. Images on the camera are kept.':'No supported still camera detected. Connect a WIA camera on Windows or install gphoto2 for a supported PTP camera.'
    if(result.devices.some(device=>device.simulated))status.textContent+=' SIMULATOR active — generated test fixtures, not a physical camera.'
    for(const backend of result.backends){if(!backend.available&&backend.message)status.textContent+=' '+backend.name+': '+backend.message}
  }
  return result
}
export async function show(){const result=await discover();if(!dialog.open)dialog.showModal();return result}
export async function capture(id){
  const result=await call('Capture',id),files=[]
  const origin=globalThis.mygo.platform==='win32'?'http://cameraphoto.localhost':'cameraphoto://localhost'
  for(const photo of result.files){
    const response=await fetch(`${origin}/${photo.id}`)
    if(!response.ok)throw Error('Cannot read the captured image')
    files.push(new File([await response.blob()],photo.name))
  }
  return {files,device:result.device}
}
export function mount(run,report){
  dispatch=run
  const open=document.createElement('button');open.textContent='Tethered capture…';open.id='tethered-capture'
  open.onclick=()=>dispatch('tether').catch(error=>report(error.message))
  document.querySelector('header').append(open)
  dialog=document.createElement('dialog')
  const title=document.createElement('h2');title.textContent='Tethered capture'
  select=document.createElement('select');select.setAttribute('aria-label','Connected still camera')
  status=document.createElement('p');status.setAttribute('role','status')
  const refresh=document.createElement('button');refresh.textContent='Refresh cameras';refresh.onclick=()=>dispatch('camera-list').catch(error=>report(error.message))
  captureButton=document.createElement('button');captureButton.textContent='Capture & add to library';captureButton.disabled=true
  captureButton.onclick=async()=>{
    captureButton.disabled=true
    try{const result=await dispatch('camera-capture',{id:select.value});status.textContent=`Added ${result.added.length} photo(s)${result.device.simulated?' from SIMULATOR':''}.`;if(result.failed.length)status.textContent+=' '+result.failed.map(item=>item.error).join('; ')}
    catch(error){status.textContent=error.message}
    finally{captureButton.disabled=!select.value}
  }
  const close=document.createElement('button');close.textContent='Close';close.onclick=()=>dialog.close()
  dialog.append(title,select,status,refresh,captureButton,close);document.body.append(dialog)
}
