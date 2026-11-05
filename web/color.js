import { encodeSrgb, decodeSrgb } from './color-spaces.js'
export { createGlobalTone, globalToneParameters, globalToneRgb } from './tone.js'

// Parameters use sRGB for hue selection and linear-light luminance for tonal edits.
const channels = {
  Red: 0,
  Orange: 30,
  Yellow: 60,
  Green: 120,
  Aqua: 180,
  Blue: 240,
  Purple: 275,
  Magenta: 320
}
export const mixerControls = Object.fromEntries(
  Object.keys(channels).flatMap((color) =>
    ['Hue', 'Saturation', 'Luminance'].map((component) => [color + ' ' + component, [-100, 100, 1]])
  )
)
export function createMixer(edit) {
  return mixer(edit, false)
}
// Float HSL uses extended encoded sRGB. For signed/HDR colors, an affine
// envelope maps the full channel range into the HSL cube and restores it after
// the artistic edit. Unselected colors return without any transfer round trip.
export function createFloatMixer(edit) {
  return mixer(edit, true)
}
function mixer(edit, float) {
  const active = Object.entries(channels).filter(([name]) =>
    ['Hue', 'Saturation', 'Luminance'].some((c) => edit[name + ' ' + c])
  )
  const points = (edit.pointColors || [])
    .filter((p) => p.hue || p.saturation || p.luminance)
    .map((p) => ({ ...p, rgb: [1, 3, 5].map((i) => parseInt(p.color.slice(i, i + 2), 16) / 255) }))
  if (!active.length && !points.length) return null
  return (data, i) => {
    let r = float ? encodeSrgb(data[i]) : data[i] / 255,
      g = float ? encodeSrgb(data[i + 1]) : data[i + 1] / 255,
      b = float ? encodeSrgb(data[i + 2]) : data[i + 2] / 255
    const selected = [r, g, b],
      offset = float ? Math.min(0, r, g, b) : 0,
      span = float ? Math.max(1, r, g, b) - offset : 1
    if (float) {
      r = (r - offset) / span
      g = (g - offset) / span
      b = (b - offset) / span
    }
    const hi = Math.max(r, g, b),
      lo = Math.min(r, g, b),
      delta = hi - lo
    if (!delta) return
    let h = 60 * (hi === r ? (g - b) / delta : hi === g ? 2 + (b - r) / delta : 4 + (r - g) / delta)
    h = (h + 360) % 360
    let l = (hi + lo) / 2,
      s = delta / (1 - Math.abs(2 * l - 1)),
      dh = 0,
      ds = 0,
      dl = 0
    for (const [name, center] of active) {
      const distance = Math.abs(h - center)
      const weight = Math.max(0, 1 - Math.min(distance, 360 - distance) / 45) / 100
      dh += (edit[name + ' Hue'] || 0) * weight * 30
      ds += (edit[name + ' Saturation'] || 0) * weight
      dl += (edit[name + ' Luminance'] || 0) * weight
    }
    for (const p of points) {
      const distance =
        Math.hypot(selected[0] - p.rgb[0], selected[1] - p.rgb[1], selected[2] - p.rgb[2]) / Math.sqrt(3)
      const t = p.range ? Math.max(0, 1 - distance / (p.range / 100)) : Number(distance === 0)
      const weight = t * t * (3 - 2 * t)
      dh += p.hue * weight
      ds += (p.saturation * weight) / 100
      dl += (p.luminance * weight) / 100
    }
    if (float && !dh && !ds && !dl) return
    h = ((h + dh + 3600) % 360) / 60
    s = Math.min(1, Math.max(0, s * (1 + ds)))
    l = Math.min(1, Math.max(0, l + (dl > 0 ? 1 - l : l) * dl * 0.6))
    const c = (1 - Math.abs(2 * l - 1)) * s,
      x = c * (1 - Math.abs((h % 2) - 1)),
      m = l - c / 2
    const sector = Math.floor(h)
    const rgb = [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x]
    ][sector]
    for (let k = 0; k < 3; k++)
      data[i + k] = float ? decodeSrgb((rgb[k] + m) * span + offset) : (rgb[k] + m) * 255
  }
}
const neighbors = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1]
]
export function spatialEffects(data, width, height, edit) {
  return spatial(data, width, height, edit, false)
}
// Spatial edits work directly in linear light. Transparent neighbors contribute
// no color; normalized neighbor weights preserve straight alpha and HDR values.
export function spatialEffectsFloat(data, width, height, edit) {
  return spatial(data, width, height, edit, true)
}
function spatial(data, width, height, edit, float) {
  const sharp = (edit.Sharpening || 0) / 100,
    noise = (edit['Noise reduction'] || 0) / 100
  const vignette = (edit.Vignette || 0) / 100,
    grain = (edit.Grain || 0) / 100
  const clarity = (edit.Clarity || 0) / 100,
    texture = (edit.Texture || 0) / 100
  if (!sharp && !noise && !vignette && !grain && !clarity && !texture) return
  const source = sharp || noise || clarity || texture ? data.slice() : null
  const radius = Math.max(1, Math.round(Math.min(width, height) * 0.008))
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const d = (((x + 0.5) / width) * 2 - 1) ** 2 + (((y + 0.5) / height) * 2 - 1) ** 2
      const edge = Math.min(1, d / 1.7) ** 1.5 * vignette
      // A reproducible grain pattern for repeated exports at a given resolution.
      let hash = Math.imul(x + 1, 0x45d9f3b) ^ Math.imul(y + 1, 0x27d4eb2d)
      hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b)
      const scale = float ? 1 : 255,
        speck = ((hash >>> 0) / 0xffffffff - 0.5) * grain * (float ? 38 / 255 : 38)
      for (let k = 0; k < 3; k++) {
        let v = data[i + k]
        if (source) {
          let sum = 0,
            weight = 0,
            wide = 0,
            wideWeight = 0
          for (const [dx, dy] of neighbors) {
            const index =
              (Math.max(0, Math.min(height - 1, y + dy)) * width + Math.max(0, Math.min(width - 1, x + dx))) *
                4 +
              k
            const n = source[index],
              alpha = float ? source[index - k + 3] : 1,
              w = alpha / (1 + Math.abs(n - v) / (float ? 12 / 255 : 12))
            sum += n * w
            weight += w
            if (clarity) {
              const wideIndex =
                (Math.max(0, Math.min(height - 1, y + dy * radius)) * width +
                  Math.max(0, Math.min(width - 1, x + dx * radius))) *
                4
              const alpha = float ? source[wideIndex + 3] : 1
              wide += source[wideIndex + k] * alpha
              wideWeight += alpha
            }
          }
          const detail = weight ? v - sum / weight : 0
          v += detail * (sharp * 3 + texture * 2 - noise)
          if (clarity && wideWeight) v += (v - wide / wideWeight) * clarity * 0.7
        }
        data[i + k] = v + (edge < 0 ? v : scale - v) * edge + speck
      }
    }
}
// Linear interpolation between the endpoints and three editable quarter stops.
export function toneCurve(edit) {
  const stops = curveStops(edit)
  if (!stops) return null
  return Uint8ClampedArray.from({ length: 256 }, (_, i) => curveValue(i / 255, stops))
}
function curveStops(edit) {
  const keys = ['Curve shadows', 'Curve midtones', 'Curve lights']
  if (!keys.some((k) => edit[k])) return null
  return [0, ...keys.map((k, i) => Math.max(0, Math.min(255, 64 * (i + 1) + (edit[k] || 0) * 0.8))), 255]
}
function curveValue(value, stops) {
  const pos = value * 4,
    lo = Math.min(3, Math.floor(pos))
  return stops[lo] + (pos - lo) * (stops[lo + 1] - stops[lo])
}
// Continuous encoded-sRGB interpolation shares the legacy control stops, with
// an identity extension outside display black/white. Only editable stop values
// are bounded; input/output RGB never goes through a byte lookup or clamp.
export function createFloatToneCurve(edit) {
  const stops = curveStops(edit)
  if (!stops) return null
  return (linear) => {
    if (linear <= 0 || linear >= 1) return linear
    return decodeSrgb(curveValue(encodeSrgb(linear), stops) / 255)
  }
}
