import { COLOR_SPACES } from './color-spaces.js'

export const EXPORT_COLOR_MESSAGES = {
  label: 'Color space',
  unsupported: 'This format does not support the requested output color space'
}

export function exportColorSpaces(format) {
  if (['image/jpeg', 'image/png', 'image/tiff'].includes(format)) return Object.keys(COLOR_SPACES)
  if (['image/avif', 'image/jxl'].includes(format)) return ['srgb']
  return []
}

export function validateExportColorSpace(format, colorSpace) {
  if (colorSpace === undefined) return 'srgb'
  if (!exportColorSpaces(format).includes(colorSpace)) throw Error(EXPORT_COLOR_MESSAGES.unsupported)
  return colorSpace
}
