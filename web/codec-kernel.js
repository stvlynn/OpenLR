import UTIF from './vendor/codecs/utif.js'
import { convertSrgbPixels, makeColorProfile } from './color-spaces.js'
import { encodeColorPng, encodeColorTiff } from './color-containers.js'
import { validateExportColorSpace } from './export-color.js'
import { validateRgbProfile } from './color-profile.js'

async function managedRgb(pixels, profile) {
  // Reuse the host CMS for native RGB samples from both TIFF and AVIF.
  const tagged = encodeColorPng(pixels, validateRgbProfile(profile)),
    bitmap = await createImageBitmap(new Blob([tagged], { type: 'image/png' }))
  try {
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(pixels.width, pixels.height)
        : document.createElement('canvas')
    canvas.width = pixels.width
    canvas.height = pixels.height
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    return context.getImageData(0, 0, pixels.width, pixels.height)
  } finally {
    bitmap.close()
  }
}
function orientTiff(pixels, orientation) {
  if (!orientation || orientation === 1) return pixels
  const { width, height, data } = pixels,
    swapped = orientation >= 5 && orientation <= 8,
    w = swapped ? height : width,
    h = swapped ? width : height,
    out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let u = x,
        v = y
      if (orientation === 2) u = width - 1 - x
      if (orientation === 3) {
        u = width - 1 - x
        v = height - 1 - y
      }
      if (orientation === 4) v = height - 1 - y
      if (orientation === 5) {
        u = y
        v = x
      }
      if (orientation === 6) {
        u = height - 1 - y
        v = x
      }
      if (orientation === 7) {
        u = height - 1 - y
        v = width - 1 - x
      }
      if (orientation === 8) {
        u = y
        v = width - 1 - x
      }
      out.set(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (v * w + u) * 4)
    }
  return new ImageData(out, w, h)
}
export async function processCodec({ operation, format, file, pixels, quality, colorSpace = 'srgb' }) {
  try {
    if (operation === 'decode') {
      const bytes = await file.arrayBuffer()
      let result
      if (format === 'image/tiff') {
        const header = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength))
        if (
          header.length < 8 ||
          !(
            (header[0] === 73 && header[1] === 73 && header[2] === 42 && header[3] === 0) ||
            (header[0] === 77 && header[1] === 77 && header[2] === 0 && header[3] === 42)
          )
        )
          throw Error('Invalid or unsupported TIFF header')
        const ifds = UTIF.decode(bytes),
          image = ifds.find((ifd) => ifd.t256?.[0] > 0 && ifd.t257?.[0] > 0)
        if (!image) throw Error('No TIFF image was found')
        if (image.t50706 || image.t262?.[0] === 32803) throw Error('A sensor DNG must use the RAW decoder')
        const interpretation = image.t262?.[0] ?? 2,
          bits = image.t258?.[0] ?? 1
        if (
          ![0, 1, 2, 3, 5].includes(interpretation) ||
          (image.t339?.[0] ?? 1) !== 1 ||
          image.t284?.[0] === 2 ||
          ![1, 2, 4, 8, 16].includes(bits) ||
          (interpretation === 3 && bits !== 8)
        )
          throw Error('Unsupported TIFF pixel layout')
        UTIF.decodeImage(bytes, image)
        const rgba = UTIF.toRGBA8(image)
        if (!image.width || !image.height || rgba.length !== image.width * image.height * 4)
          throw Error('Invalid TIFF pixel data')
        if (image.t338?.[0] === 1 && (image.t258?.length ?? 0) === 4)
          for (let i = 0; i < rgba.length; i += 4)
            for (let c = 0; c < 3; c++)
              rgba[i + c] = rgba[i + 3] ? Math.min(255, Math.round((rgba[i + c] * 255) / rgba[i + 3])) : 0
        const profile = image.t34675
        if (profile?.length) {
          if (interpretation !== 2) throw Error('Unsupported TIFF color profile layout')
          rgba.set(
            (
              await managedRgb(
                { width: image.width, height: image.height, data: rgba },
                Uint8Array.from(profile)
              )
            ).data
          )
        }
        result = orientTiff(
          new ImageData(
            new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
            image.width,
            image.height
          ),
          image.t274?.[0]
        )
      } else if (format === 'image/avif') {
        const { decodeAvif } = await import('./color-codecs.js'),
          decoded = await decodeAvif(bytes)
        if (decoded.icc.length) result = await managedRgb(decoded, decoded.icc)
        else if ([1, 2].includes(decoded.colorPrimaries) && [2, 13].includes(decoded.transferCharacteristics))
          result = new ImageData(decoded.data, decoded.width, decoded.height)
        else {
          // Other CICP transfers (including HDR) require the host's original-file decoder.
          return { bitmap: await createImageBitmap(file) }
        }
      } else if (format === 'image/jxl')
        result = await (await import('./vendor/codecs/jxl/decode.js')).default(bytes)
      else throw Error('Unsupported image format')
      return { bitmap: await createImageBitmap(result) }
    } else if (operation === 'prepare-color') {
      validateExportColorSpace(format, colorSpace)
      const converted = convertSrgbPixels(pixels, colorSpace)
      return { bytes: converted.data.buffer, profile: makeColorProfile(colorSpace) }
    } else if (operation === 'encode') {
      validateExportColorSpace(format, colorSpace)
      let bytes
      if (format === 'image/tiff' || format === 'image/png') {
        const converted = convertSrgbPixels(pixels, colorSpace),
          profile = makeColorProfile(colorSpace)
        bytes = (format === 'image/tiff' ? encodeColorTiff : encodeColorPng)(converted, profile)
      } else {
        const { encodeProfiled } = await import('./color-codecs.js')
        bytes = await encodeProfiled(
          format,
          convertSrgbPixels(pixels, colorSpace),
          makeColorProfile(colorSpace),
          quality,
          colorSpace
        )
      }
      if (!bytes?.byteLength) throw Error('The image encoder returned no data')
      if (ArrayBuffer.isView(bytes))
        bytes =
          bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      return { bytes }
    } else throw Error('Unknown image codec operation')
  } catch (error) {
    throw Object.assign(new Error(format + ' ' + operation + ' failed: ' + error.message, { cause: error }), {
      code: 'CODEC_ERROR'
    })
  }
}
