import { runImageWorker } from './image-worker.js'
import { assertLinearFrame } from './pixel-frame.js'
import { decodeSrgb, encodeSrgb } from './color-spaces.js'
export async function analyzeFocus(image) {
  const scale = Math.min(1, 640 / Math.max(image.width, image.height)),
    canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const result = await runImageWorker(
    new URL('./culling-worker.js', import.meta.url),
    { pixels },
    [pixels.data.buffer],
    async (data) => (await import('./culling-kernel.js')).evaluatePhoto(data)
  )
  return result.review
}
export function validEye(r) {
  return (
    r &&
    [r.x, r.y, r.rx, r.ry].every(Number.isFinite) &&
    r.x >= 0 &&
    r.x <= 1 &&
    r.y >= 0 &&
    r.y <= 1 &&
    r.rx > 0 &&
    r.ry > 0 &&
    r.rx <= 1 &&
    r.ry <= 1
  )
}
function correctedRed(red, green, blue, distance, range = 255) {
  if (distance >= 1 || red < 60 * (range / 255)) return red
  const neutral = (green + blue) / 2,
    excess = (red - Math.max(green, blue)) / Math.max(range / 255, red),
    weight = Math.max(0, Math.min(1, (excess - 0.15) * 3)) * Math.min(1, (1 - distance) * 6)
  return red - (red - neutral) * weight
}
export function correctEyes(source, eyes, maxEdge) {
  if (!eyes?.length) return source
  const canvas = document.createElement('canvas'),
    scale = Math.min(1, maxEdge / Math.max(source.width, source.height))
  canvas.width = Math.max(1, Math.round(source.width * scale))
  canvas.height = Math.max(1, Math.round(source.height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  for (const eye of eyes) {
    if (!validEye(eye)) continue
    const cx = eye.x * canvas.width,
      cy = eye.y * canvas.height,
      rx = eye.rx * canvas.width,
      ry = eye.ry * canvas.height
    const x = Math.max(0, Math.floor(cx - rx)),
      y = Math.max(0, Math.floor(cy - ry))
    const w = Math.min(canvas.width, Math.ceil(cx + rx)) - x,
      h = Math.min(canvas.height, Math.ceil(cy + ry)) - y
    if (!w || !h) continue
    const pixels = ctx.getImageData(x, y, w, h),
      data = pixels.data
    for (let j = 0; j < h; j++)
      for (let k = 0; k < w; k++) {
        const i = (j * w + k) * 4,
          d = ((x + k + 0.5 - cx) / rx) ** 2 + ((y + j + 0.5 - cy) / ry) ** 2
        data[i] = correctedRed(data[i], data[i + 1], data[i + 2], d)
      }
    ctx.putImageData(pixels, x, y)
  }
  return canvas
}
// Preserve the existing sRGB selection/neutralization rule analytically. Only
// corrected red samples cross the transfer function; no base image is encoded.
export function correctEyesFrame(frame, eyes) {
  assertLinearFrame(frame)
  if (!eyes?.length) return frame
  const { width, height } = frame,
    data = new Float32Array(frame.data)
  for (const eye of eyes) {
    if (!validEye(eye)) continue
    const cx = eye.x * width,
      cy = eye.y * height,
      rx = eye.rx * width,
      ry = eye.ry * height,
      left = Math.max(0, Math.floor(cx - rx)),
      top = Math.max(0, Math.floor(cy - ry)),
      right = Math.min(width, Math.ceil(cx + rx)),
      bottom = Math.min(height, Math.ceil(cy + ry))
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) {
        const offset = (y * width + x) * 4,
          d = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2
        if (d >= 1) continue
        const red = encodeSrgb(data[offset])
        const green = encodeSrgb(data[offset + 1]),
          blue = encodeSrgb(data[offset + 2]),
          corrected = correctedRed(red, green, blue, d, 1)
        if (corrected !== red) data[offset] = decodeSrgb(corrected)
      }
  }
  return { ...frame, data }
}
