import { validateExportOptions } from './agent-protocol.js'
import { EXPORT_FORMATS } from './formats.js'
import { exportColorSpaces, validateExportColorSpace } from './export-color.js'
import { validateExportMetadataPolicy } from './export-metadata.js'
import { validateOutputSharpening } from './export-sharpening.js'

export const EXPORT_SETTINGS_MESSAGES = {
  previous: 'Export again',
  previousDescription: 'Export with previous settings',
  missing: 'Choose export settings first',
  changedPhoto: 'The selected photo changed. Open Export again.',
  rememberFailed: 'Export saved, but settings could not be remembered: ',
  selectVideo: 'Select a video',
  invalidMedia: 'Choose a photo or video',
  dngOptions: 'DNG preserves RAW pixels; use a rendered format for resizing or watermarks'
}

function validateMedia(media) {
  if (media !== 'photo' && media !== 'video') throw Error(EXPORT_SETTINGS_MESSAGES.invalidMedia)
}

export function normalizeExportSettings(options, media) {
  validateMedia(media)
  validateExportOptions(options)
  const format = options.format ?? (media === 'video' ? 'video/mp4' : 'image/jpeg'),
    definition = EXPORT_FORMATS.find((item) => item.value === format),
    colorSpace = validateExportColorSpace(format, options.colorSpace),
    result = { format }
  const metadata = validateExportMetadataPolicy(format, options.metadata)
  if (metadata !== 'none') result.metadata = metadata
  const outputSharpening = validateOutputSharpening(format, options.outputSharpening)
  if (outputSharpening !== 'none') result.outputSharpening = outputSharpening
  if (media === 'photo' && format.startsWith('video/')) throw Error(EXPORT_SETTINGS_MESSAGES.selectVideo)
  if (definition.quality) result.quality = options.quality ?? 0.92
  if (exportColorSpaces(format).length) result.colorSpace = colorSpace
  if (format === 'image/x-adobe-dng' && (options.maxSize !== undefined || options.watermark))
    throw Error(EXPORT_SETTINGS_MESSAGES.dngOptions)
  if (!['original', 'original-settings', 'application/rdf+xml', 'image/x-adobe-dng'].includes(format)) {
    if (options.maxSize !== undefined) result.maxSize = options.maxSize
    if (options.watermark) result.watermark = options.watermark
  }
  return result
}

function readRecord(storage, key) {
  const text = storage.getItem(key)
  if (text === null) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function storedSettings(value, media) {
  if (!value || !Object.hasOwn(value, 'format')) return null
  try {
    return normalizeExportSettings(value, media)
  } catch {
    return null
  }
}

export function loadExportSettings(storage = globalThis.localStorage) {
  const current = readRecord(storage, 'export-settings'),
    legacy = readRecord(storage, 'last-export'),
    result = { photo: null, video: null }
  for (const media of ['photo', 'video'])
    result[media] = storedSettings(current && Object.hasOwn(current, media) ? current[media] : legacy, media)
  return result
}

export function saveExportSettings({ media, options }, storage = globalThis.localStorage) {
  return saveExportSettingsBatch([{ media, options }], storage)
}

export function saveExportSettingsBatch(settings, storage = globalThis.localStorage) {
  const result = { ...loadExportSettings(storage) }
  for (const { media, options } of settings) result[media] = normalizeExportSettings(options, media)
  // One storage write commits the captured media slot without a second cleanup
  // operation that could fail after the settings have already changed.
  storage.setItem('export-settings', JSON.stringify(result))
  return result
}
