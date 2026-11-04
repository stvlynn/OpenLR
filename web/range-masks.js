const clamp = (v) => Math.max(0, Math.min(1, v))
const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
function ramp(distance, softness) {
  if (distance <= 0) return 1
  if (!softness || distance >= softness) return 0
  const t = 1 - distance / softness
  return t * t * (3 - 2 * t)
}
export const RANGE_TYPES = ['color-range', 'luminance-range']
export function validateRange(type, value) {
  const number = (v, key) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)
      throw Error(key + ' must be between 0 and 1')
    return v
  }
  const softness = number(value.softness ?? 0.1, 'softness')
  if (type === 'color-range') {
    if (typeof value.color !== 'string' || !/^#[\da-f]{6}$/i.test(value.color))
      throw Error('Color range needs an sRGB #RRGGBB color')
    return {
      color: value.color.toLowerCase(),
      tolerance: number(value.tolerance ?? 0.1, 'tolerance'),
      softness
    }
  }
  const min = number(value.min ?? 0, 'min'),
    max = number(value.max ?? 1, 'max')
  if (min > max) throw Error('Range minimum must not exceed maximum')
  return { min, max, softness }
}
export function rangeWeight(tool, rgb) {
  if (!rgb) return 0
  if (tool.type === 'color-range') {
    const reference = [1, 3, 5].map((offset) => parseInt(tool.color.slice(offset, offset + 2), 16) / 255)
    const distance = Math.hypot(...reference.map((v, i) => v - rgb[i] / 255)) / Math.sqrt(3)
    return ramp(distance - tool.tolerance, tool.softness)
  }
  const luminance =
    linear(rgb[0] / 255) * 0.2126 + linear(rgb[1] / 255) * 0.7152 + linear(rgb[2] / 255) * 0.0722
  return ramp(Math.max(tool.min - luminance, luminance - tool.max), tool.softness)
}
export function combineCoverage(a, b, operation) {
  return clamp(operation === 'add' ? a + b - a * b : operation === 'subtract' ? a * (1 - b) : a * b)
}
