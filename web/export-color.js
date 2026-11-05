import { COLOR_SPACES } from './color-spaces.js'
import { RENDERED_PHOTO_TYPES } from './formats.js'

export const EXPORT_COLOR_MESSAGES = {
  label: 'Color space',
  unsupported: 'This format does not support the requested output color space'
}

export function exportColorSpaces(format) {
  if (RENDERED_PHOTO_TYPES.includes(format)) return Object.keys(COLOR_SPACES)
  return []
}

export function validateExportColorSpace(format, colorSpace) {
  if (colorSpace === undefined) return 'srgb'
  if (!exportColorSpaces(format).includes(colorSpace)) throw Error(EXPORT_COLOR_MESSAGES.unsupported)
  return colorSpace
}
