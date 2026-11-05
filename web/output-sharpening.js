import { assertLinearFrame } from './pixel-frame.js'
import { OUTPUT_SHARPENING_LEVELS, OUTPUT_SHARPENING_MESSAGES } from './export-sharpening.js'

const gains = { low: 0.3, standard: 0.6, high: 1 },
  sigma = 0.65,
  radius = Math.ceil(3 * sigma),
  kernel = Float64Array.from({ length: radius * 2 + 1 }, (_, i) =>
    Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma))
  )
const total = kernel.reduce((sum, value) => sum + value, 0)
for (let i = 0; i < kernel.length; i++) kernel[i] /= total
const luminance = (data, i) => data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722

// Operates on the caller's owned, final-size frame, before watermarks and output
// color conversion. Only the added detail is bounded; signed/HDR RGB is not.
export function applyFrameOutputSharpening(frame, level = 'none') {
  if (!OUTPUT_SHARPENING_LEVELS.includes(level)) throw Error(OUTPUT_SHARPENING_MESSAGES.invalid)
  assertLinearFrame(frame)
  if (level === 'none') return frame
  const { width, height, data } = frame,
    gain = gains[level],
    limit = 0.015 * gain,
    weighted = new Float64Array(width * height),
    coverage = new Float64Array(width * height)
  // Blur luminance times alpha and alpha with the same normalized kernel.
  // Both horizontal planes are complete before any source sample changes.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      for (let dx = -radius; dx <= radius; dx++) {
        const i = (y * width + Math.max(0, Math.min(width - 1, x + dx))) * 4,
          weight = kernel[dx + radius] * data[i + 3]
        weighted[p] += luminance(data, i) * weight
        coverage[p] += weight
      }
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (!data[i + 3]) continue
      let sum = 0,
        weight = 0
      for (let dy = -radius; dy <= radius; dy++) {
        const p = Math.max(0, Math.min(height - 1, y + dy)) * width + x,
          coefficient = kernel[dy + radius]
        sum += weighted[p] * coefficient
        weight += coverage[p] * coefficient
      }
      const original = luminance(data, i),
        detail = original - sum / weight
      // Ignore arithmetic roundoff so uniform colors (including zero channels)
      // remain exactly uniform rather than acquiring tiny floating residuals.
      if (Math.abs(detail) <= Number.EPSILON * Math.max(1, Math.abs(original)) * 8) continue
      const delta = Math.max(-limit, Math.min(limit, detail * gain))
      for (let c = 0; c < 3; c++) data[i + c] += delta
    }
  return frame
}
