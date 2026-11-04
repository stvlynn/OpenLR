const buffers=new WeakMap()
export function encodeSoftMask({width,height,mask}){
  let binary=''
  for(let offset=0;offset<mask.length;offset+=8192)binary+=String.fromCharCode(...mask.subarray(offset,offset+8192))
  return {width,height,encoding:'base64-u8',data:btoa(binary)}
}
export function validateSoftMask(raster){
  if(!raster||raster.encoding!=='base64-u8'||!Number.isSafeInteger(raster.width)||!Number.isSafeInteger(raster.height)||raster.width<1||raster.height<1||typeof raster.data!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(raster.data))throw Error('Expected a normalized soft-mask raster')
  const value={width:raster.width,height:raster.height,encoding:'base64-u8',data:raster.data}
  const bytes=decodeSoftMask(value)
  if(bytes.length!==raster.width*raster.height)throw Error('Soft-mask sample count does not match dimensions')
  return value
}
export function decodeSoftMask(raster){
  if(!buffers.has(raster))buffers.set(raster,Uint8Array.from(atob(raster.data),c=>c.charCodeAt(0)))
  return buffers.get(raster)
}
export function sampleSoftMask(raster,x,y){
  const data=decodeSoftMask(raster),{width,height}=raster
  const px=Math.max(0,Math.min(width-1,x*width-0.5)),py=Math.max(0,Math.min(height-1,y*height-0.5)),x0=Math.floor(px),y0=Math.floor(py),x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1),fx=px-x0,fy=py-y0
  return ((data[y0*width+x0]*(1-fx)+data[y0*width+x1]*fx)*(1-fy)+(data[y1*width+x0]*(1-fx)+data[y1*width+x1]*fx)*fy)/255
}
