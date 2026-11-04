import { localWeight, applyLocalTools } from './local-tools.js'
import { filledSource } from './fill.js'
import { render } from './render.js'

export function maskCoverageSource(image, edit, tool, { maxEdge = Infinity, style = 'rgba' } = {}) {
  if (!['gray', 'rgba'].includes(style)) throw Error('Expected gray or rgba mask preview')
  const canvas = document.createElement('canvas'),
    scale = Math.min(1, maxEdge / Math.max(image.width, image.height))
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(filledSource(image, edit.fills, maxEdge), 0, 0, canvas.width, canvas.height)
  const reference = applyLocalTools(ctx.getImageData(0, 0, canvas.width, canvas.height), {
      repairs: edit.localTools?.repairs ?? []
    }),
    pixels = ctx.createImageData(canvas.width, canvas.height)
  for (let i = 0; i < canvas.width * canvas.height; i++) {
    const value = Math.round(
      255 *
        localWeight(
          tool,
          ((i % canvas.width) + 0.5) / canvas.width,
          (Math.floor(i / canvas.width) + 0.5) / canvas.height,
          canvas.width,
          canvas.height,
          reference.data.subarray(i * 4, i * 4 + 3)
        )
    )
    pixels.data[i * 4] = style === 'rgba' ? 255 : value
    pixels.data[i * 4 + 1] = pixels.data[i * 4 + 2] = style === 'rgba' ? 0 : value
    pixels.data[i * 4 + 3] = style === 'rgba' ? value : 255
  }
  ctx.putImageData(pixels, 0, 0)
  return canvas
}
export function renderMaskPreview(image, edit, tool, { maxSize = Infinity, style = 'gray' } = {}) {
  // Keep source resolution until crop/optics; masks have no global color edits.
  const coverage = maskCoverageSource(image, edit, tool, { style })
  return render(
    coverage,
    {
      crop: edit.crop,
      turn: edit.turn,
      flip: edit.flip,
      optics: { ...edit.optics, profileTCA: false, redScale: 0, blueScale: 0 }
    },
    maxSize
  )
}
