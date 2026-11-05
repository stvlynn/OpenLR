import { LibRaw } from './vendor/libraw/index.js'
import { encodeSrgb } from './color-spaces.js'

export async function decodeRaw(file, { linear = false } = {}) {
  let decoder
  try {
    await LibRaw.initialize()
    decoder = new LibRaw()
    await decoder.waitUntilReady()
    decoder.open(await file.arrayBuffer())
    // Decode one full-size camera-white-balanced linear sRGB base, without auto exposure.
    // Edits stay in render.js and the original sensor bytes stay in the catalog.
    decoder.setHalfSize(0)
    decoder.setUseCameraWb(1)
    decoder.setOutputColor(1)
    decoder.setOutputBps(16)
    decoder.setGamma(0, 1)
    decoder.setGamma(1, 1)
    decoder.setNoAutoBright(1)
    decoder.setBright(1)
    decoder.unpack()
    decoder.dcrawProcess()
    const image = decoder.dcrawMakeMemImage()
    if (
      image.type_ !== 'LIBRAW_IMAGE_BITMAP' ||
      image.bits !== 16 ||
      ![1, 3, 4].includes(image.colors) ||
      !image.width ||
      !image.height ||
      image.data.length !== image.width * image.height * image.colors * 2
    )
      throw { code: 'RAW_LAYOUT' }
    const rgba = new Uint8ClampedArray(image.width * image.height * 4)
    const channels = linear ? new Float32Array(image.width * image.height * 3) : null
    const words = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength)
    for (let pixel = 0, input = 0; pixel < rgba.length; pixel += 4, input += image.colors) {
      for (let c = 0; c < 3; c++) {
        const channel = input + (image.colors === 1 ? 0 : c)
        const value = words.getUint16(channel * 2, true) / 65535
        if (channels) channels[(pixel / 4) * 3 + c] = value
        rgba[pixel + c] = 255 * encodeSrgb(value)
      }
      rgba[pixel + 3] = 255
    }
    decoder.dispose()
    decoder = null
    if (linear) return { width: image.width, height: image.height, linear: channels, data: rgba }
    return await createImageBitmap(new ImageData(rgba, image.width, image.height))
  } catch (error) {
    throw Object.assign(new Error(error.message || 'RAW decoding failed', { cause: error }), {
      code: error.code === 'RAW_LAYOUT' ? 'RAW_LAYOUT' : 'RAW_DECODE'
    })
  } finally {
    decoder?.dispose()
  }
}
