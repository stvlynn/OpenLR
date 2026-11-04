import {decodePhoto} from './decode.js'
import {metadata} from './metadata.js'
import {render,toBlob} from './render.js'

export async function mergePhotos(kind,photos,readOriginal,options={}){
  if(photos.length<2)throw Error('Select at least two photos to merge')
  if(photos.some(photo=>photo.deleted))throw Error('Restore deleted photos before merging')
  const frames=[]
  for(const photo of photos){
    const {file}=await readOriginal(photo.id),image=await decodePhoto(file)
    try{
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height
      const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0)
      const rgba=context.getImageData(0,0,canvas.width,canvas.height)
      frames.push({width:rgba.width,height:rgba.height,data:rgba.data,metadata:photo.metadata??await metadata(file)})
    }finally{image.close()}
  }
  const worker=new Worker(new URL('./merge-worker.js',import.meta.url),{type:'module'})
  try{
    const result=await new Promise((resolve,reject)=>{
      worker.onmessage=({data})=>data.ok?resolve(data.result):reject(Error(data.error))
      worker.onerror=event=>reject(Error(event.message||'Image merge worker failed'))
      worker.postMessage({kind,frames,options},frames.map(frame=>frame.data.buffer))
    })
    const canvas=document.createElement('canvas');canvas.width=result.width;canvas.height=result.height
    canvas.getContext('2d').putImageData(new ImageData(result.data,result.width,result.height),0,0)
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('Cannot encode merged image')),'image/png'))
    const stem=photos[0].name.replace(/\.[^.]+$/,''),filename=stem+(kind==='hdr'?'-HDR':'-Panorama')+'.png'
    return {file:new File([blob],filename,{type:'image/png'}),width:result.width,height:result.height,thumbnail:await toBlob(render(canvas,{},240)),radiance:result.radiance?new Blob([result.radiance],{type:'image/vnd.radiance'}):null,diagnostics:{...result.diagnostics,sources:photos.map(photo=>({id:photo.id,name:photo.name}))}}
  }finally{worker.terminate()}
}
