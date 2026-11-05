import { inflateSync } from './vendor/fflate/browser.js'
import { validCrop } from './geometry.js'
import { assertLinearFrame, rgba8ToLinearFrame, sampleLinearRgba } from './pixel-frame.js'
const patchCanvases = new WeakMap()
const patchFrames = new WeakMap()
const encodedPatches = new WeakMap()
export function validateFill(p) {
  if (
    !validCrop(p) ||
    !Number.isSafeInteger(p.width) ||
    !Number.isSafeInteger(p.height) ||
    p.width < 1 ||
    p.height < 1 ||
    typeof p.rgba !== 'string'
  )
    throw Error('Invalid content-aware repair')
  return p
}
export function validatePostRepairFills(fills) {
  if (!Array.isArray(fills)) throw Error('Invalid post-repair fills')
  const ids = new Set()
  for (const fill of fills) {
    validateFill(fill)
    if (typeof fill.id !== 'string' || !fill.id || ids.has(fill.id))
      throw Error('Post-repair fills need unique IDs')
    ids.add(fill.id)
  }
  return fills
}
function patchPixels(p) {
  validateFill(p)
  const bits = inflateSync(Uint8Array.from(atob(p.rgba), (c) => c.charCodeAt(0)))
  if (bits.length !== p.width * p.height * 4) throw Error('Incomplete repair pixels')
  return {
    width: p.width,
    height: p.height,
    data: new Uint8ClampedArray(bits.buffer, bits.byteOffset, bits.byteLength)
  }
}
function texture(p) {
  if (patchCanvases.has(p)) return patchCanvases.get(p)
  const pixels = patchPixels(p),
    canvas = document.createElement('canvas')
  canvas.width = p.width
  canvas.height = p.height
  canvas.getContext('2d').putImageData(new ImageData(pixels.data, p.width, p.height), 0, 0)
  patchCanvases.set(p, canvas)
  return canvas
}
function patchFrame(p) {
  if (!patchFrames.has(p)) patchFrames.set(p, rgba8ToLinearFrame(patchPixels(p)))
  return patchFrames.get(p)
}
function encodedPatch(p) {
  if (!encodedPatches.has(p)) {
    const { width, height, data } = patchPixels(p)
    // The premultiplied sampler expects normalized alpha. RGB stays encoded.
    const samples = Float32Array.from(data, (value, i) => (i % 4 === 3 ? value / 255 : value))
    encodedPatches.set(p, { width, height, data: samples })
  }
  return encodedPatches.get(p)
}
function compositeFills({ width, height, data }, fills, readPatch, alphaScale) {
  const sample = new Float64Array(4)
  for (const p of fills) {
    const patch = readPatch(p),
      left = p.x * width,
      top = p.y * height,
      patchWidth = p.w * width,
      patchHeight = p.h * height,
      right = Math.min(width, Math.ceil(left + patchWidth)),
      bottom = Math.min(height, Math.ceil(top + patchHeight))
    for (let y = Math.max(0, Math.floor(top)); y < bottom; y++)
      for (let x = Math.max(0, Math.floor(left)); x < right; x++) {
        const sx = Math.max(
            0,
            Math.min(patch.width - 1, ((x + 0.5 - left) * patch.width) / patchWidth - 0.5)
          ),
          sy = Math.max(0, Math.min(patch.height - 1, ((y + 0.5 - top) * patch.height) / patchHeight - 0.5)),
          coverage =
            (Math.min(x + 1, left + patchWidth) - Math.max(x, left)) *
            (Math.min(y + 1, top + patchHeight) - Math.max(y, top))
        if (!sampleLinearRgba(patch, sx, sy, sample) || !sample[3]) continue
        const offset = (y * width + x) * 4,
          alpha = sample[3] * coverage,
          remaining = (data[offset + 3] / alphaScale) * (1 - alpha),
          outputAlpha = alpha + remaining
        for (let channel = 0; channel < 3; channel++)
          data[offset + channel] =
            (sample[channel] * alpha + data[offset + channel] * remaining) / outputAlpha
        data[offset + 3] = outputAlpha * alphaScale
      }
  }
}
// Baked repairs remain their original 8-bit sRGB assets. Only those samples are
// decoded; transparent/absent patch coverage leaves the float base untouched.
export function filledFrame(frame, fills) {
  assertLinearFrame(frame)
  if (!fills?.length) return frame
  return fillOwnedFrame({ ...frame, data: new Float32Array(frame.data) }, fills)
}
export function fillOwnedFrame(frame, fills) {
  if (fills?.length) compositeFills(frame, fills, patchFrame, 1)
  return frame
}
export function fillOwnedPixels(pixels, fills) {
  if (fills?.length) compositeFills(pixels, fills, encodedPatch, 255)
  return pixels
}
export function filledSource(image, fills, size = Infinity) {
  if (!fills?.length) return image
  const scale = Math.min(1, size / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  for (const p of fills)
    ctx.drawImage(
      texture(p),
      p.x * canvas.width,
      p.y * canvas.height,
      p.w * canvas.width,
      p.h * canvas.height
    )
  return canvas
}
