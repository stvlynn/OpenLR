import { inflateSync } from './vendor/fflate/browser.js'
import { validCrop } from './geometry.js'
import { runImageWorker } from './image-worker.js'
import { assertLinearFrame, rgba8ToLinearFrame, sampleLinearRgba } from './pixel-frame.js'
const patchCanvases = new WeakMap()
const patchFrames = new WeakMap()
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
// Baked repairs remain their original 8-bit sRGB assets. Only those samples are
// decoded; transparent/absent patch coverage leaves the float base untouched.
export function filledFrame(frame, fills) {
  assertLinearFrame(frame)
  if (!fills?.length) return frame
  const { width, height } = frame,
    data = new Float32Array(frame.data),
    sample = new Float64Array(4)
  for (const p of fills) {
    const patch = patchFrame(p),
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
          remaining = data[offset + 3] * (1 - alpha),
          outputAlpha = alpha + remaining
        for (let channel = 0; channel < 3; channel++)
          data[offset + channel] =
            (sample[channel] * alpha + data[offset + channel] * remaining) / outputAlpha
        data[offset + 3] = outputAlpha
      }
  }
  return { ...frame, data }
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
export async function removeMaskedArea(image, recipe, mask, algorithm, radius) {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(filledSource(image, recipe.fills), 0, 0)
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const result = await runImageWorker(
    new URL('./inpaint-worker.js', import.meta.url),
    { pixels, mask, algorithm, radius },
    [pixels.data.buffer],
    async (args) => (await import('./inpaint-kernel.js')).makeFill(args)
  )
  return {
    ...recipe,
    fills: [...(recipe.fills || []), result.patch],
    localTools: { ...recipe.localTools, masks: recipe.localTools.masks.filter((m) => m.id !== mask.id) }
  }
}
