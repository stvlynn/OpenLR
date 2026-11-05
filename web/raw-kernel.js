import { LibRaw } from './vendor/libraw/index.js'
import { encodeSrgb } from './color-spaces.js'

// Inverse of the exact output_color=4 matrix in the pinned LibRaw source:
// [ .529317, .330092, .140588; .098368, .873465, .028169;
//   .016879, .117663, .865457 ]. See research/high-precision-raw.md.
// This is the decoder's specific linear output definition, not a generic
// ProPhoto transfer/profile interpretation. No gamut clipping is applied here.
const srgbFromLibRawWide = [
  2.03419260729548, -0.727419819620256, -0.30676553702329973, -0.2288107628343688, 1.231729226050609,
  -0.002921616028596869, -0.008564927236315686, -0.15327259100038765, 1.1618389609260644
]

export async function decodeRaw(file, { linear = false, working = false } = {}) {
  if (linear && working)
    throw Object.assign(new TypeError('RAW linear and working decode purposes are mutually exclusive'), {
      code: 'RAW_DECODE'
    })
  let decoder
  try {
    await LibRaw.initialize()
    decoder = new LibRaw()
    await decoder.waitUntilReady()
    decoder.open(await file.arrayBuffer())
    // Decode a full-size camera-white-balanced linear base, without auto exposure.
    // Legacy bitmap/DNG/HDR retain color 1. Only working frames use wide color 4.
    // Edits stay in render.js and the original sensor bytes stay in the catalog.
    decoder.setHalfSize(0)
    decoder.setUseCameraWb(1)
    decoder.setOutputColor(working ? 4 : 1)
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
    const words = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength)
    if (working) {
      const data = new Float32Array(image.width * image.height * 4)
      for (let pixel = 0, input = 0; pixel < data.length; pixel += 4, input += image.colors) {
        const r = words.getUint16(input * 2, true) / 65535,
          g = words.getUint16((input + (image.colors === 1 ? 0 : 1)) * 2, true) / 65535,
          b = words.getUint16((input + (image.colors === 1 ? 0 : 2)) * 2, true) / 65535
        for (let c = 0; c < 3; c++) {
          const row = c * 3
          data[pixel + c] =
            srgbFromLibRawWide[row] * r + srgbFromLibRawWide[row + 1] * g + srgbFromLibRawWide[row + 2] * b
        }
        data[pixel + 3] = 1
      }
      return {
        width: image.width,
        height: image.height,
        data,
        colorSpace: 'srgb-linear',
        provenance: {
          decoder: 'libraw',
          outputColor: 4,
          outputBits: 16,
          transfer: 'linear',
          transform: 'libraw-wide-to-srgb-v1',
          precision: 'uint16-processed'
        }
      }
    }
    const rgba = new Uint8ClampedArray(image.width * image.height * 4)
    const channels = linear ? new Float32Array(image.width * image.height * 3) : null
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
