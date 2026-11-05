import { validateSoftMask, sampleSoftMask } from './soft-mask.js'
import { assertLinearFrame } from './pixel-frame.js'
export function depthRangeWeight(value, min, max, softness) {
  const distance = Math.max(min - value, value - max, 0)
  if (!distance) return 1
  if (!softness || distance >= softness) return 0
  const t = 1 - distance / softness
  return t * t * (3 - 2 * t)
}
export function validateDepthSettings(value = {}) {
  const settings = {
    enabled: value.enabled ?? true,
    amount: value.amount ?? 0.025,
    min: value.min ?? 0.45,
    max: value.max ?? 0.75,
    softness: value.softness ?? 0.15
  }
  validateDepthChanges(value)
  if (settings.min > settings.max) throw Error('Focus minimum must not exceed maximum')
  return settings
}
export function validateDepthChanges(value = {}) {
  const settings = { enabled: true, amount: 0.025, min: 0.45, max: 0.75, softness: 0.15, ...value }
  if (
    typeof settings.enabled !== 'boolean' ||
    Object.keys(value).some((key) => !['enabled', 'amount', 'min', 'max', 'softness'].includes(key))
  )
    throw Error('Invalid lens blur settings')
  for (const key of ['amount', 'min', 'max', 'softness'])
    if (
      typeof settings[key] !== 'number' ||
      !Number.isFinite(settings[key]) ||
      settings[key] < 0 ||
      settings[key] > (key === 'amount' ? 0.15 : 1)
    )
      throw Error('Invalid lens blur ' + key)
  if (value.min !== undefined && value.max !== undefined && value.min > value.max)
    throw Error('Focus minimum must not exceed maximum')
  return value
}
function blurPass(input, output, width, height, radius, horizontal) {
  const length = horizontal ? width : height,
    lines = horizontal ? height : width,
    stride = horizontal ? 5 : width * 5
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width * 5 : line * 5,
      sum = [0, 0, 0, 0, 0]
    for (let n = -radius; n <= radius; n++) {
      const offset = base + Math.max(0, Math.min(length - 1, n)) * stride
      for (let c = 0; c < 5; c++) sum[c] += input[offset + c]
    }
    for (let n = 0; n < length; n++) {
      const offset = base + n * stride,
        remove = base + Math.max(0, n - radius) * stride,
        add = base + Math.min(length - 1, n + radius + 1) * stride
      for (let c = 0; c < 5; c++) {
        output[offset + c] = sum[c] / (radius * 2 + 1)
        sum[c] += input[add + c] - input[remove + c]
      }
    }
  }
}
export function applyLensBlur(pixels, depth, settings) {
  if (!depth || !settings?.enabled || !settings.amount) return pixels
  if (pixels.data instanceof Float32Array) assertLinearFrame(pixels)
  validateSoftMask(depth.raster)
  const { width, height, data } = pixels,
    alphaScale = data instanceof Float32Array ? 1 : 255,
    source = data.slice(),
    count = width * height,
    field = new Float32Array(count * 5),
    scratch = new Float32Array(count * 5),
    values = new Float32Array(count),
    weights = new Float32Array(count)
  const radius = Math.max(1, Math.round((settings.amount * Math.min(width, height)) / Math.sqrt(3)))
  for (let i = 0; i < count; i++) {
    values[i] = sampleSoftMask(
      depth.raster,
      ((i % width) + 0.5) / width,
      (Math.floor(i / width) + 0.5) / height
    )
    weights[i] = 1 - depthRangeWeight(values[i], settings.min, settings.max, settings.softness)
  }
  // Float fields contain linear RGB with normalized alpha; byte fields retain
  // their legacy encoded RGB and output rounding. Neither alters the base domain.
  // Two normalized convolution fields keep sharp in-focus colors out of both
  // defocus planes. This is deterministic lens-style blur, not an optics solver.
  for (const near of [false, true]) {
    for (let i = 0; i < count; i++) {
      const belongs = near ? values[i] > settings.max : values[i] < settings.min,
        w = belongs ? weights[i] : 0,
        alpha = source[i * 4 + 3] / alphaScale
      for (let c = 0; c < 3; c++) field[i * 5 + c] = source[i * 4 + c] * alpha * w
      field[i * 5 + 3] = alpha * w
      field[i * 5 + 4] = w
    }
    for (let pass = 0; pass < 3; pass++) {
      blurPass(field, scratch, width, height, radius, true)
      blurPass(scratch, field, width, height, radius, false)
    }
    for (let i = 0; i < count; i++) {
      if (!(near ? values[i] > settings.max : values[i] < settings.min) || field[i * 5 + 4] < 1e-8) continue
      const w = weights[i],
        oldAlpha = source[i * 4 + 3] / alphaScale,
        newAlpha = field[i * 5 + 3] / field[i * 5 + 4],
        alpha = oldAlpha * (1 - w) + newAlpha * w
      for (let c = 0; c < 3; c++)
        data[i * 4 + c] = alpha
          ? (source[i * 4 + c] * oldAlpha * (1 - w) + (field[i * 5 + c] / field[i * 5 + 4]) * w) / alpha
          : 0
      data[i * 4 + 3] = alpha * alphaScale
    }
  }
  return pixels
}
