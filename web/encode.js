import { CODEC_TYPES } from './formats.js'
import { runImageWorker } from './image-worker.js'
import { validateExportColorSpace } from './export-color.js'

async function nativeEncode(canvas, format, quality) {
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(Error('Image export failed'))),
      format,
      quality
    )
  )
  if (blob.type !== format) throw Error('The browser did not encode the requested image format')
  return blob
}

async function codec(message) {
  return runImageWorker(
    new URL('./codec-worker.js', import.meta.url),
    message,
    [message.pixels.data.buffer],
    async (request) => (await import('./codec-kernel.js')).processCodec(request)
  )
}

export async function encodePhoto(canvas, format = 'image/jpeg', quality = 0.92, colorSpace = 'srgb') {
  validateExportColorSpace(format, colorSpace)
  if (CODEC_TYPES.includes(format) || (format === 'image/png' && colorSpace !== 'srgb')) {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    const { bytes } = await codec({ operation: 'encode', format, pixels, quality, colorSpace })
    return new Blob([bytes], { type: format })
  }
  if (!['image/jpeg', 'image/png'].includes(format)) throw Error('Unsupported export format')
  if (colorSpace === 'srgb') return nativeEncode(canvas, format, quality)
  // Flatten JPEG transparency in the existing sRGB rendering space before conversion.
  const output = document.createElement('canvas')
  output.width = canvas.width
  output.height = canvas.height
  const ctx = output.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, output.width, output.height)
  ctx.drawImage(canvas, 0, 0)
  const pixels = ctx.getImageData(0, 0, output.width, output.height)
  const { bytes, profile } = await codec({ operation: 'prepare-color', format, pixels, colorSpace })
  // putImageData supplies literal target RGB samples; replace the encoder's color declaration below.
  ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes), output.width, output.height), 0, 0)
  const blob = await nativeEncode(output, format, quality)
  const { embedJpegProfile } = await import('./color-containers.js')
  return new Blob([embedJpegProfile(await blob.arrayBuffer(), profile)], { type: format })
}
