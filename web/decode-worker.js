import {LibRaw} from './vendor/libraw/index.js'

self.onmessage=async ({data:{file}})=>{
  let decoder, bitmap
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
    decoder.setOutputBps(8)
    decoder.setNoAutoBright(1)
    decoder.setBright(1)
    decoder.unpack()
    decoder.dcrawProcess()
    const image=decoder.dcrawMakeMemImage()
    if(image.type_!=='LIBRAW_IMAGE_BITMAP' || image.bits!==8 || ![1,3,4].includes(image.colors) ||
      !image.width || !image.height ||
      image.data.length!==image.width*image.height*image.colors) throw {code:'RAW_LAYOUT'}
    const rgba=new Uint8ClampedArray(image.width*image.height*4)
    for(let pixel=0, input=0;pixel<rgba.length;pixel+=4,input+=image.colors){
      rgba[pixel]=image.data[input]
      rgba[pixel+1]=image.data[input+(image.colors===1?0:1)]
      rgba[pixel+2]=image.data[input+(image.colors===1?0:2)]
      rgba[pixel+3]=255
    }
    decoder.dispose()
    decoder=null
    bitmap=await createImageBitmap(new ImageData(rgba,image.width,image.height))
    self.postMessage({bitmap},[bitmap])
    bitmap=null
  }catch(error){
    self.postMessage({code:error.code==='RAW_LAYOUT'?'RAW_LAYOUT':'RAW_DECODE'})
  }finally{
    decoder?.dispose()
    bitmap?.close()
  }
}
