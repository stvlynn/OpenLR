import {LibRaw} from './vendor/libraw/index.js'

export async function decodeRaw(file,{linear=false}={}){
  let decoder
  try{
    await LibRaw.initialize()
    decoder=new LibRaw()
    await decoder.waitUntilReady()
    decoder.open(await file.arrayBuffer())
    // Decode a full-size camera-white-balanced sRGB base, without auto exposure.
    // Edits stay in render.js and the original sensor bytes stay in the catalog.
    decoder.setHalfSize(0)
    decoder.setUseCameraWb(1)
    decoder.setOutputColor(1)
    decoder.setOutputBps(linear?16:8)
    if(linear){decoder.setGamma(0,1);decoder.setGamma(1,1)}
    decoder.setNoAutoBright(1)
    decoder.setBright(1)
    decoder.unpack()
    decoder.dcrawProcess()
    const image=decoder.dcrawMakeMemImage()
    if(image.type_!=='LIBRAW_IMAGE_BITMAP' || image.bits!==(linear?16:8) || ![1,3,4].includes(image.colors) ||
      !image.width || !image.height ||
      image.data.length!==image.width*image.height*image.colors*(linear?2:1)) throw {code:'RAW_LAYOUT'}
    const rgba=new Uint8ClampedArray(image.width*image.height*4)
    const channels=linear?new Float32Array(image.width*image.height*3):null
    const words=linear?new DataView(image.data.buffer,image.data.byteOffset,image.data.byteLength):null
    const display=value=>255*(value<=0.0031308?12.92*value:1.055*value**(1/2.4)-0.055)
    for(let pixel=0, input=0;pixel<rgba.length;pixel+=4,input+=image.colors){
      for(let c=0;c<3;c++){
        const channel=input+(image.colors===1?0:c)
        if(linear){const value=words.getUint16(channel*2,true)/65535;channels[pixel/4*3+c]=value;rgba[pixel+c]=display(value)}
        else rgba[pixel+c]=image.data[channel]
      }
      rgba[pixel+3]=255
    }
    decoder.dispose()
    decoder=null
    if(linear)return {width:image.width,height:image.height,linear:channels,data:rgba}
    return await createImageBitmap(new ImageData(rgba,image.width,image.height))
  }catch(error){
    throw Object.assign(new Error(error.message||'RAW decoding failed',{cause:error}),{code:error.code==='RAW_LAYOUT'?'RAW_LAYOUT':'RAW_DECODE'})
  }finally{
    decoder?.dispose()
  }
}
