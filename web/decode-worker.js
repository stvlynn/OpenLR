import {decodeRaw} from './raw-kernel.js'
self.onmessage=async({data:{file}})=>{
  let bitmap
  try{bitmap=await decodeRaw(file);self.postMessage({bitmap},[bitmap]);bitmap=null}
  catch(error){self.postMessage({code:error.code||'RAW_DECODE',message:error.message})}
  finally{bitmap?.close()}
}
self.postMessage({ready:true})
