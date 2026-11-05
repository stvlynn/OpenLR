import { RENDERED_PHOTO_TYPES } from './formats.js'

export const OUTPUT_SHARPENING_LEVELS = ['none', 'low', 'standard', 'high']
export const OUTPUT_SHARPENING_MESSAGES = {
  label: 'Output sharpening',
  levels: { none: 'None', low: 'Low', standard: 'Standard', high: 'High' },
  invalid: 'Choose a supported output sharpening level',
  unsupported: 'This format does not support output sharpening'
}

export function outputSharpeningLevels(format) {
  return RENDERED_PHOTO_TYPES.includes(format) ? [...OUTPUT_SHARPENING_LEVELS] : []
}

export function validateOutputSharpening(format, level = 'none') {
  if (!OUTPUT_SHARPENING_LEVELS.includes(level)) throw Error(OUTPUT_SHARPENING_MESSAGES.invalid)
  if (level !== 'none' && !RENDERED_PHOTO_TYPES.includes(format))
    throw Error(OUTPUT_SHARPENING_MESSAGES.unsupported)
  return level
}
