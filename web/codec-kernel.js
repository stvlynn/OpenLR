import UTIF from './vendor/codecs/utif.js'
import { convertSrgbPixels, makeColorProfile } from './color-spaces.js'
import { encodeColorPng, encodeColorTiff } from './color-containers.js'
import { validateExportColorSpace } from './export-color.js'
import { validateRgbProfile } from './color-profile.js'
import { readTiff, tiffEncodedPixels, orientTiffPixels } from './tiff.js'
import { convertInputPixels } from './input-color.js'
import { rgba8ToLinearFrame } from './pixel-frame.js'

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
async function displayFrame(bitmap, provenance) {
  try {
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    return {
      ...rgba8ToLinearFrame(context.getImageData(0, 0, bitmap.width, bitmap.height)),
      provenance: { ...provenance, precision: 'rgba8-display' }
    }
  } finally {
    bitmap.close()
  }
}

function normalizedAvif(decoded) {
  const { width, height, data, bitDepth } = decoded
  if (
    ![8, 10, 12, 16].includes(bitDepth) ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    !Number.isSafeInteger(width * height * 4) ||
    data.length !== width * height * 4
  )
    throw Error('Invalid AVIF sample layout')
  const maximum = 2 ** bitDepth - 1
  return { width, height, data: Float32Array.from(data, (value) => value / maximum) }
}

export async function processCodec({ operation, format, file, pixels, quality, colorSpace = 'srgb' }) {
  try {
    if (operation === 'decode' || operation === 'decode-frame') {
      const working = operation === 'decode-frame',
        bytes = await file.arrayBuffer()
      let result,
        provenance = { decoder: format, compatibilityReason: 'display-decoder' }
      if (format === 'image/tiff') {
        const image = readTiff(bytes),
          interpretation = image.t262?.[0] ?? 2
        if (working) {
          const encoded = tiffEncodedPixels(image)
          provenance = { decoder: 'utif', sourceBits: encoded.sourceBits ?? image.t258?.[0] ?? 1 }
          if (!encoded.reason) {
            const profile = image.t34675?.length ? Uint8Array.from(image.t34675) : undefined
            if (profile && ![2, 3].includes(interpretation))
              throw Error('Unsupported TIFF color profile layout')
            const converted = convertInputPixels(encoded, {
              profile,
              provenance: {
                ...provenance,
                precision: encoded.sourceBits > 8 ? 'uint16-source' : 'integer-source'
              }
            })
            if (converted.frame) return { frame: orientTiffPixels(converted.frame, image.t274?.[0]) }
            provenance.compatibilityReason = converted.reason
          } else provenance.compatibilityReason = encoded.reason
        }
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
        const oriented = orientTiffPixels(
          new ImageData(
            new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
            image.width,
            image.height
          ),
          image.t274?.[0]
        )
        result = new ImageData(oriented.data, oriented.width, oriented.height)
      } else if (format === 'image/avif') {
        const { decodeAvif } = await import('./color-codecs.js')
        let decoded = await decodeAvif(bytes, working ? 16 : 8)
        if (working) {
          const encoded = normalizedAvif(decoded)
          const sourceSpace =
            [1, 2].includes(decoded.colorPrimaries) && [2, 13].includes(decoded.transferCharacteristics)
              ? 'srgb'
              : decoded.colorPrimaries === 12 && decoded.transferCharacteristics === 13
                ? 'display-p3'
                : null
          provenance = {
            decoder: 'libavif',
            sourceBits: decoded.sourceBitDepth,
            colorPrimaries: decoded.colorPrimaries,
            transferCharacteristics: decoded.transferCharacteristics
          }
          if (decoded.icc.length || sourceSpace) {
            const converted = convertInputPixels(encoded, {
              profile: decoded.icc,
              sourceSpace: sourceSpace ?? 'srgb',
              provenance: { ...provenance, precision: 'integer-source' }
            })
            if (converted.frame) return { frame: converted.frame }
            provenance.compatibilityReason = converted.reason
          } else provenance.compatibilityReason = 'avif-cicp'
          // Only the explicit compatibility path reduces samples for the host CMS.
          decoded = {
            ...decoded,
            bitDepth: 8,
            data: Uint8ClampedArray.from(decoded.data, (value) => (value * 255) / 65535)
          }
        }
        if (decoded.icc.length) result = await managedRgb(decoded, decoded.icc)
        else if ([1, 2].includes(decoded.colorPrimaries) && [2, 13].includes(decoded.transferCharacteristics))
          result = new ImageData(decoded.data, decoded.width, decoded.height)
        else {
          const bitmap = await createImageBitmap(file)
          return working ? { frame: await displayFrame(bitmap, provenance) } : { bitmap }
        }
      } else if (format === 'image/jxl')
        result = await (await import('./vendor/codecs/jxl/decode.js')).default(bytes)
      else throw Error('Unsupported image format')
      const bitmap = await createImageBitmap(result)
      return working ? { frame: await displayFrame(bitmap, provenance) } : { bitmap }
    } else if (operation === 'prepare-color') {
      validateExportColorSpace(format, colorSpace)
      const converted = convertSrgbPixels(pixels, colorSpace)
      return { bytes: converted.data.buffer, profile: makeColorProfile(colorSpace) }
    } else if (operation === 'encode' || operation === 'encode-target') {
      validateExportColorSpace(format, colorSpace)
      const converted = operation === 'encode' ? convertSrgbPixels(pixels, colorSpace) : pixels
      const profile = makeColorProfile(colorSpace)
      let bytes
      if (format === 'image/tiff' || format === 'image/png') {
        bytes = (format === 'image/tiff' ? encodeColorTiff : encodeColorPng)(converted, profile)
      } else {
        const { encodeProfiled } = await import('./color-codecs.js')
        bytes = await encodeProfiled(format, converted, profile, quality, colorSpace)
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
