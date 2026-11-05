import { exportColorSpaces } from './export-color.js'
import { exportMetadataPolicies } from './export-metadata.js'
import { outputSharpeningLevels } from './export-sharpening.js'
import { decodeSrgb } from './color-spaces.js'
import { assertLinearFrame, rgba8ToLinearFrame, linearFrameToRgba8 } from './pixel-frame.js'
import { applyFrameOutputSharpening } from './output-sharpening.js'

export function readExportOptions() {
  const get = (id) => document.getElementById(id).value
  const args = { format: get('format'), quality: Number(get('quality')) / 100 }
  if (exportColorSpaces(args.format).length) args.colorSpace = get('export-color-space')
  if (exportMetadataPolicies(args.format).length) args.metadata = get('export-metadata')
  if (outputSharpeningLevels(args.format).length) args.outputSharpening = get('export-sharpening')
  if (!['original', 'original-settings', 'application/rdf+xml', 'image/x-adobe-dng'].includes(args.format)) {
    if (get('export-size')) args.maxSize = Number(get('export-size'))
    if (get('watermark').trim()) args.watermark = get('watermark').trim()
  }
  return args
}
export function applyWatermark(canvas, text) {
  if (!text) return
  const ctx = canvas.getContext('2d')
  ctx.save()
  ctx.resetTransform()
  const size = Math.max(1, Math.round(Math.min(canvas.width, canvas.height) / 28))
  ctx.font = '500 ' + size + 'px sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.shadowColor = 'rgba(0,0,0,.8)'
  ctx.shadowBlur = Math.max(1, size / 6)
  ctx.fillStyle = 'rgba(255,255,255,.9)'
  ctx.fillText(text, canvas.width - size, canvas.height - size, Math.max(1, canvas.width - size * 2))
  ctx.restore()
}

export function applyOutputSharpening(canvas, level = 'none') {
  if (level === 'none') return canvas
  const context = canvas.getContext('2d'),
    frame = rgba8ToLinearFrame(context.getImageData(0, 0, canvas.width, canvas.height))
  applyFrameOutputSharpening(frame, level)
  const pixels = linearFrameToRgba8(frame)
  context.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0)
  return canvas
}

export function applyFrameWatermark(frame, text) {
  if (!text) return frame
  assertLinearFrame(frame)
  const overlay = document.createElement('canvas')
  overlay.width = frame.width
  overlay.height = frame.height
  applyWatermark(overlay, text)
  const pixels = overlay.getContext('2d').getImageData(0, 0, frame.width, frame.height).data
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3] / 255
    if (!a) continue
    const remaining = frame.data[i + 3] * (1 - a),
      alpha = a + remaining
    for (let c = 0; c < 3; c++)
      frame.data[i + c] = (decodeSrgb(pixels[i + c] / 255) * a + frame.data[i + c] * remaining) / alpha
    frame.data[i + 3] = alpha
  }
  return frame
}
