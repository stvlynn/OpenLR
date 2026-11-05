import { threads, simd } from './vendor/codecs/wasm-feature-detect.js'
import { defaultOptions as avifOptions } from './vendor/codecs/avif/meta.js'

const modules = new Map()
function load(key, factory) {
  if (!modules.has(key))
    modules.set(
      key,
      factory().then((module) => module.default())
    )
  return modules.get(key)
}
async function encoder(format) {
  const threaded = await threads()
  if (format === 'image/avif')
    return threaded
      ? load('avif-mt', () => import('./vendor/codecs/avif/codec/enc/avif_enc_mt.js'))
      : load('avif', () => import('./vendor/codecs/avif/codec/enc/avif_enc.js'))
  if (threaded && (await simd()))
    return load('jxl-mt-simd', () => import('./vendor/codecs/jxl/codec/enc/jxl_color_enc_mt_simd.js'))
  return threaded
    ? load('jxl-mt', () => import('./vendor/codecs/jxl/codec/enc/jxl_color_enc_mt.js'))
    : load('jxl', () => import('./vendor/codecs/jxl/codec/enc/jxl_color_enc.js'))
}

export async function encodeProfiled(format, pixels, profile, quality, colorSpace) {
  const module = await encoder(format),
    lossless = quality === 1,
    q = Math.round(quality * 100)
  let result
  if (format === 'image/avif') {
    result = module.encode(pixels.data, pixels.width, pixels.height, {
      ...avifOptions,
      quality: q,
      qualityAlpha: -1,
      subsample: lossless ? 3 : avifOptions.subsample,
      icc: profile,
      // ICC owns the RGB interpretation; CICP still declares the actual YUV matrix/range.
      colorPrimaries: 2,
      transferCharacteristics: 2,
      matrixCoefficients: -1,
      fullRange: true
    })
  } else {
    result = module.encodeColor(
      pixels.data,
      pixels.width,
      pixels.height,
      profile,
      q,
      lossless,
      7,
      colorSpace === 'srgb'
    )
  }
  if (!result?.byteLength) throw Error('The image encoder returned no data')
  return result
}

export async function decodeAvif(bytes, bitDepth = 8) {
  const module = await load('avif-dec', () => import('./vendor/codecs/avif/codec/dec/avif_dec.js')),
    result = module.decodeWithColor(new Uint8Array(bytes), bitDepth)
  if (!result) throw Error('Invalid AVIF image')
  return result
}

export async function decodeJxl(bytes, working = false) {
  const module = await load('jxl-dec', () => import('./vendor/codecs/jxl/codec/dec/jxl_color_dec.js')),
    result = module[working ? 'decodeWorking' : 'decode'](new Uint8Array(bytes))
  if (!result) throw Error('Invalid JPEG XL image')
  return result
}
