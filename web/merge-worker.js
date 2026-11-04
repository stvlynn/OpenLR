import {mergeHDR,mergePanorama} from './merge-core.js'
let runtime
self.onmessage=async({data:{kind,frames,options}})=>{
  try{
    if(!runtime){await import('./vendor/opencv/opencv.js');runtime=await globalThis.cv}
    const result=kind==='hdr'?mergeHDR(runtime,frames,options):mergePanorama(runtime,frames,options)
    self.postMessage({ok:true,result},[result.data.buffer,...(result.radiance?[result.radiance.buffer]:[])])
  }catch(error){self.postMessage({ok:false,error:error.message||String(error)})}
}
