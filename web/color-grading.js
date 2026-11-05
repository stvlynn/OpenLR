import { decodeSrgb } from './color-spaces.js'

export const GRADING_WHEELS = ['shadows', 'midtones', 'highlights', 'global']
const wheelFields = ['hue', 'saturation', 'luminance']
const sharedFields = ['balance', 'blending']
export const GRADING_FIELDS = [
  ...sharedFields,
  ...GRADING_WHEELS.flatMap((wheel) => wheelFields.map((field) => `${wheel}.${field}`))
]
export const GRADING_MESSAGES = {
  title: 'Color grading',
  modes: {
    three: 'Three wheels',
    shadows: 'Shadows',
    midtones: 'Midtones',
    highlights: 'Highlights',
    global: 'Global'
  },
  hue: 'Hue',
  saturation: 'Saturation',
  luminance: 'Luminance',
  balance: 'Balance',
  blending: 'Blending',
  reset: 'Reset grading',
  resetWheel: 'Reset wheel',
  wheel: 'Color wheel',
  mode: 'Grading view',
  invalid: 'Invalid color grading settings',
  changedPhoto: 'The active photo changed. Adjust color grading again.',
  changedEdit: 'The photo edits changed. Adjust color grading again.'
}

const wheelDefaults = () => ({ hue: 0, saturation: 0, luminance: 0 })
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
function bounded(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw Error(GRADING_MESSAGES.invalid)
  return value
}

export function validateColorGrading(value) {
  if (!record(value) || Object.keys(value).some((key) => ![...GRADING_WHEELS, ...sharedFields].includes(key)))
    throw Error(GRADING_MESSAGES.invalid)
  const result = {}
  for (const name of GRADING_WHEELS) {
    const wheel = value[name]
    if (wheel === undefined) result[name] = wheelDefaults()
    else {
      if (!record(wheel) || Object.keys(wheel).some((key) => !wheelFields.includes(key)))
        throw Error(GRADING_MESSAGES.invalid)
      const hue = bounded(wheel.hue, 0, 0, 360)
      result[name] = {
        hue: hue === 360 ? 0 : hue,
        saturation: bounded(wheel.saturation, 0, 0, 100),
        luminance: bounded(wheel.luminance, 0, -100, 100)
      }
    }
  }
  result.balance = bounded(value.balance, 0, -100, 100)
  result.blending = bounded(value.blending, 50, 0, 100)
  return result
}

export function validateColorGradingRecipe(edit = {}) {
  if (edit.colorGrading !== undefined) validateColorGrading(edit.colorGrading)
  return edit
}

export function colorGradingValue(edit = {}) {
  return validateColorGrading(edit.colorGrading === undefined ? {} : edit.colorGrading)
}

export function hasColorGradingEffect(value) {
  if (value === undefined) return false
  const grading = validateColorGrading(value)
  return GRADING_WHEELS.some((name) => grading[name].saturation !== 0 || grading[name].luminance !== 0)
}

export function setColorGrading(edit, value) {
  const grading = validateColorGrading(value)
  const result = { ...edit }
  if (
    grading.balance === 0 &&
    grading.blending === 50 &&
    GRADING_WHEELS.every((name) => Object.values(grading[name]).every((v) => v === 0))
  )
    delete result.colorGrading
  else result.colorGrading = grading
  return result
}

export function validateColorGradingPatch(patch) {
  if (
    !record(patch) ||
    Object.keys(patch).some((key) => !['field', 'value', 'expectedValue'].includes(key)) ||
    !GRADING_FIELDS.includes(patch.field) ||
    !Number.isFinite(patch.value) ||
    !Number.isFinite(patch.expectedValue)
  )
    throw Error(GRADING_MESSAGES.invalid)

  const [name, field] = patch.field.split('.')
  const canonical = (value) => {
    const grading = validateColorGrading(field ? { [name]: { [field]: value } } : { [name]: value })
    return field ? grading[name][field] : grading[name]
  }
  return { value: canonical(patch.value), expectedValue: canonical(patch.expectedValue), name, field }
}

export function patchColorGrading(edit, patch) {
  const { name, field, value, expectedValue } = validateColorGradingPatch(patch)
  const grading = colorGradingValue(edit)
  const target = field ? grading[name] : grading
  const key = field ?? name
  if (target[key] !== expectedValue) throw Error(GRADING_MESSAGES.changedEdit)
  if (target[key] === value) return edit
  target[key] = value
  return setColorGrading(edit, grading)
}

// Full-saturation/value encoded sRGB hue wheel, shared with the editor display.
export function hueColor(hue = 0) {
  bounded(hue, 0, 0, 360)
  const sector = (hue === 360 ? 0 : hue) / 60
  const x = 1 - Math.abs((sector % 2) - 1)
  return [
    [1, x, 0],
    [x, 1, 0],
    [0, 1, x],
    [0, x, 1],
    [x, 0, 1],
    [1, 0, x]
  ][Math.floor(sector)]
}

function weights(luminance, pivot, exponent, output) {
  const z = Math.max(0, luminance),
    t = z / (z + pivot),
    inverse = 1 - t
  const shadows = (inverse * inverse) ** exponent
  const midtones = (2 * t * inverse) ** exponent
  const highlights = (t * t) ** exponent
  const sum = shadows + midtones + highlights
  output[0] = shadows / sum
  output[1] = midtones / sum
  output[2] = highlights / sum
  return output
}

export function gradingWeights(luminance, balance = 0, blending = 50) {
  bounded(balance, 0, -100, 100)
  bounded(blending, 50, 0, 100)
  return weights(luminance, 0.18 * 2 ** (-balance / 50), 4 - (3 * blending) / 100, [])
}

// Compile once per render. Every wheel reads the same incoming RGB and mask
// weights; no wheel sees a preceding wheel's result. Alpha is never touched.
export function createColorGrading(edit = {}) {
  const grading = colorGradingValue(edit)
  if (!GRADING_WHEELS.some((name) => grading[name].saturation || grading[name].luminance)) return null
  const tint = GRADING_WHEELS.map((name) => {
    const wheel = grading[name]
    if (!wheel.saturation) return [0, 0, 0]
    const rgb = hueColor(wheel.hue).map(decodeSrgb)
    const y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    const vector = rgb.map((value) => value - y)
    const scale = Math.max(...vector.map(Math.abs))
    return vector.map((value) => ((value / scale) * wheel.saturation) / 400)
  })
  const luminance = GRADING_WHEELS.map((name) => grading[name].luminance / 50)
  const pivot = 0.18 * 2 ** (-grading.balance / 50),
    exponent = 4 - (3 * grading.blending) / 100
  const mask = new Float64Array(3)
  return (data, offset = 0) => {
    const r = data[offset],
      g = data[offset + 1],
      b = data[offset + 2]
    weights(0.2126 * r + 0.7152 * g + 0.0722 * b, pivot, exponent, mask)
    const scale = Math.max(Math.abs(r), Math.abs(g), Math.abs(b))
    let red = tint[3][0],
      green = tint[3][1],
      blue = tint[3][2],
      stops = luminance[3]
    for (let i = 0; i < 3; i++) {
      red += mask[i] * tint[i][0]
      green += mask[i] * tint[i][1]
      blue += mask[i] * tint[i][2]
      stops += mask[i] * luminance[i]
    }
    const gain = 2 ** stops
    data[offset] = (r + scale * red) * gain
    data[offset + 1] = (g + scale * green) * gain
    data[offset + 2] = (b + scale * blue) * gain
    return data
  }
}
