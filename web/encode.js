import {CODEC_TYPES} from './formats.js'
import {runImageWorker} from './image-worker.js'

export async function encodePhoto(canvas,format='image/jpeg',quality=0.92){
  if(CODEC_TYPES.includes(format)){
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height)
    const {bytes}=await runImageWorker(new URL('./codec-worker.js',import.meta.url),{operation:'encode',format,pixels,quality},[pixels.data.buffer],async message=>(await import('./codec-kernel.js')).processCodec(message))
    return new Blob([bytes],{type:format})
  }
  if(!['image/jpeg','image/png'].includes(format))throw Error('Unsupported export format')
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(result=>result?resolve(result):reject(Error('Image export failed')),format,quality))
  if(blob.type!==format)throw Error('The browser did not encode the requested image format')
  return blob
}
