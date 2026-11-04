import {makeFill} from './inpaint-kernel.js'
self.postMessage({ready:true})
self.onmessage=async({data})=>{
  try{self.postMessage(await makeFill(data))}catch(error){self.postMessage({code:'INPAINT',message:error.message})}
}
