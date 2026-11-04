import { runImageWorker } from './image-worker.js'
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
        if (d >= 1 || data[i] < 60) continue
        const neutral = (data[i + 1] + data[i + 2]) / 2,
          excess = (data[i] - Math.max(data[i + 1], data[i + 2])) / Math.max(1, data[i])
        const weight = Math.max(0, Math.min(1, (excess - 0.15) * 3)) * Math.min(1, (1 - d) * 6)
        data[i] -= (data[i] - neutral) * weight
      }
    ctx.putImageData(pixels, x, y)
  }
  return canvas
}
