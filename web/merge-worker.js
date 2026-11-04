import {processMerge} from './merge-kernel.js'
self.onmessage=async({data})=>{
  try{
    const {result}=await processMerge(data)
    self.postMessage({result},[result.data.buffer,...(result.radiance?[result.radiance.buffer]:[])])
  }catch(error){self.postMessage({code:'MERGE_FAILED',message:error.message||String(error)})}
}
self.postMessage({ready:true})
