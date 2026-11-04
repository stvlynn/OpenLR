import { inflateSync } from './vendor/fflate/browser.js'
import { validCrop } from './geometry.js'
import { runImageWorker } from './image-worker.js'
const patchCanvases = new WeakMap()
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
function texture(p) {
  if (patchCanvases.has(p)) return patchCanvases.get(p)
  validateFill(p)
  const canvas = document.createElement('canvas')
  canvas.width = p.width
  canvas.height = p.height
  const bits = inflateSync(Uint8Array.from(atob(p.rgba), (c) => c.charCodeAt(0)))
  if (bits.length !== p.width * p.height * 4) throw Error('Incomplete repair pixels')
  canvas
    .getContext('2d')
    .putImageData(
      new ImageData(new Uint8ClampedArray(bits.buffer, bits.byteOffset, bits.byteLength), p.width, p.height),
      0,
      0
    )
  patchCanvases.set(p, canvas)
  return canvas
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
