import * as ort from './vendor/onnx/ort.wasm.min.mjs'
ort.env.wasm.wasmPaths=new URL('./vendor/onnx/',import.meta.url).href
ort.env.wasm.numThreads=1
ort.env.wasm.proxy=false
const sessions=new Map()
export {ort}
export async function modelSession(key,getBytes){
  if(!sessions.has(key)){
    const pending=(async()=>ort.InferenceSession.create(await getBytes(),{executionProviders:['wasm'],graphOptimizationLevel:'all'}))()
    sessions.set(key,pending)
    pending.catch(()=>sessions.delete(key))
  }
  return sessions.get(key)
}
export async function fetchModel(url){
  const response=await fetch(url,{cache:'no-store'})
  if(!response.ok)throw Error('Cannot load the segmentation model: HTTP '+response.status)
  return response.arrayBuffer()
}
export async function cachedSkyModel(model){
  const db=await new Promise((resolve,reject)=>{
    const request=indexedDB.open('openlr-models',1)
    request.onupgradeneeded=()=>request.result.createObjectStore('weights')
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)
  })
  try{
    const record=await new Promise((resolve,reject)=>{
      const request=db.transaction('weights').objectStore('weights').get('sky')
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)
    })
    if(record?.url===model.url)return record.bytes instanceof Blob?record.bytes.arrayBuffer():record.bytes
    const bytes=await fetchModel(model.url)
    await new Promise((resolve,reject)=>{
      const transaction=db.transaction('weights','readwrite')
      // Blob backing storage avoids Chromium's serialized ArrayBuffer record limit.
      transaction.objectStore('weights').put({url:model.url,revision:model.revision,bytes:new Blob([bytes],{type:'application/octet-stream'})},'sky')
      transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error)
    })
    return bytes
  }finally{db.close()}
}
