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
  if(!response.ok)throw Error('Cannot load the image model: HTTP '+response.status)
  return response.arrayBuffer()
}
export const cachedSkyModel=model=>cachedModel(model,'sky')
export async function cachedModel(model,key){
  const db=await new Promise((resolve,reject)=>{
    const request=indexedDB.open('openlr-models',1)
    request.onupgradeneeded=()=>request.result.createObjectStore('weights')
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)
  })
  try{
    const record=await new Promise((resolve,reject)=>{
      const request=db.transaction('weights').objectStore('weights').get(key)
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)
    })
    if(record?.url===model.url){
      if(record.bytes)return record.bytes instanceof Blob?record.bytes.arrayBuffer():record.bytes
      if(!Number.isSafeInteger(record.chunkCount)||!Number.isSafeInteger(record.byteLength))throw Error('Invalid cached model record')
      const bytes=new Uint8Array(record.byteLength)
      await new Promise((resolve,reject)=>{
        const transaction=db.transaction('weights'),store=transaction.objectStore('weights')
        let offset=0
        for(let index=0;index<record.chunkCount;index++){
          const request=store.get(key+':'+index)
          request.onsuccess=()=>{try{if(!(request.result instanceof ArrayBuffer))throw Error('Missing model chunk');const chunk=new Uint8Array(request.result);bytes.set(chunk,offset);offset+=chunk.length}catch{transaction.abort()}}
        }
        transaction.oncomplete=()=>offset===bytes.length?resolve():reject(Error('Incomplete cached model'))
        transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error??Error('Missing cached model chunk'))
      })
      return bytes.buffer
    }
    const bytes=await fetchModel(model.url)
    await new Promise((resolve,reject)=>{
      const transaction=db.transaction('weights','readwrite')
      // ArrayBuffer chunks support ephemeral WKWebView (which rejects Blob writes)
      // and avoid Chromium's single-record serialization limit for large models.
      const store=transaction.objectStore('weights'),chunkSize=16*1024*1024,chunkCount=Math.ceil(bytes.byteLength/chunkSize)
      for(let index=0;index<(record?.chunkCount??0);index++)store.delete(key+':'+index)
      for(let index=0;index<chunkCount;index++)store.put(bytes.slice(index*chunkSize,(index+1)*chunkSize),key+':'+index)
      store.put({url:model.url,revision:model.revision,byteLength:bytes.byteLength,chunkCount},key)
      transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error)
    })
    return bytes
  }finally{db.close()}
}
