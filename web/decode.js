import { isVideo, poster } from './video.js'
// One codec boundary for import, reopening originals, preview, and export.
import { CODEC_TYPES, photoFormat } from './formats.js'
import { runImageWorker } from './image-worker.js'
export const RAW_EXTENSIONS = [
  '3fr',
  'ari',
  'arw',
  'bay',
  'braw',
  'cap',
  'cine',
  'cr2',
  'cr3',
  'crw',
  'cs1',
  'dc2',
  'dcr',
  'dng',
  'drf',
  'eip',
  'erf',
  'fff',
  'gpr',
  'iiq',
  'k25',
  'kdc',
  'mdc',
  'mef',
  'mos',
  'mrw',
  'nef',
  'nrw',
  'obm',
  'orf',
  'pef',
  'ptx',
  'pxn',
  'qtk',
  'raf',
  'raw',
  'rdc',
  'rw2',
  'rwl',
  'rwz',
  'sr2',
  'srf',
  'srw',
  'sti',
  'x3f'
]
export const PHOTO_ACCEPT =
  'image/*,.tif,.tiff,.avif,.jxl,' + RAW_EXTENSIONS.map((ext) => '.' + ext).join(',')
export const RAW_PREVIEW_VERSION = 1
export const isRawPhoto = (photo) =>
  RAW_EXTENSIONS.includes((photo.sourceName || photo.name || '').split('.').pop().toLowerCase())
const MESSAGES = {
  EMPTY: 'The photo is empty.',
  RAW_DECODE: 'This RAW format or compression could not be decoded.',
  RAW_LAYOUT: 'The RAW decoder returned an unsupported pixel layout.',
  RAW_WORKER: 'The RAW decoder could not start or ran out of memory.',
  RAW_TIMEOUT: 'The RAW decoder exceeded its two minute time limit.',
  IMAGE_DECODE: 'This image format could not be decoded.'
}
export class PhotoDecodeError extends Error {
  constructor(code, cause) {
    super(MESSAGES[code] || MESSAGES.RAW_DECODE, { cause })
    this.name = 'PhotoDecodeError'
    this.code = code
  }
}
export async function decodePhotoLinear(file) {
  if (!file?.size) throw new PhotoDecodeError('EMPTY')
  if (!isRawPhoto(file))
    throw Error('Linear RAW decoding requires a camera RAW/DNG file')
  return (
    await runImageWorker(
      new URL('./decode-worker.js', import.meta.url),
      { file, linear: true },
      [],
      async ({ file }) => ({
        frame: await (await import('./raw-kernel.js')).decodeRaw(file, { linear: true })
      })
    )
  ).frame
}
export async function decodePhoto(file) {
  if (file && isVideo(file)) return (await poster(file)).bitmap
  if (!file?.size) throw new PhotoDecodeError('EMPTY')
  if (!isRawPhoto(file)) {
    const format = photoFormat(file)
    if (CODEC_TYPES.includes(format)) {
      const { bitmap } = await runImageWorker(
        new URL('./codec-worker.js', import.meta.url),
        { operation: 'decode', format, file },
        [],
        async (message) => (await import('./codec-kernel.js')).processCodec(message)
      )
      return bitmap
    }
    try {
      return await createImageBitmap(file)
    } catch (error) {
      throw new PhotoDecodeError('IMAGE_DECODE', error)
    }
  }
  try {
    return (
      await runImageWorker(
        new URL('./decode-worker.js', import.meta.url),
        { file },
        [],
        async ({ file }) => ({ bitmap: await (await import('./raw-kernel.js')).decodeRaw(file) })
      )
    ).bitmap
  } catch (error) {
    throw new PhotoDecodeError(
      error.code === 'TIMEOUT'
        ? 'RAW_TIMEOUT'
        : error.code === 'WORKER'
          ? 'RAW_WORKER'
          : error.code === 'RAW_LAYOUT'
            ? 'RAW_LAYOUT'
            : 'RAW_DECODE',
      error
    )
  }
}
