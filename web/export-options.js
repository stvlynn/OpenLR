import { exportColorSpaces } from './export-color.js'

export function readExportOptions() {
  const get = (id) => document.getElementById(id).value
  const args = { format: get('format'), quality: Number(get('quality')) / 100 }
  if (exportColorSpaces(args.format).length) args.colorSpace = get('export-color-space')
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
