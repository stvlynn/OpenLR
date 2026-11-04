import { runImageWorker } from './image-worker.js'
import { encodeSoftMask } from './soft-mask.js'
export async function estimateDepth(image) {
  // DPT lower-bound resize, preserving aspect and rounding to the patch multiple.
  const scale = 518 / Math.min(image.width, image.height),
    canvas = document.createElement('canvas')
  canvas.width = Math.max(14, Math.round((image.width * scale) / 14) * 14)
  canvas.height = Math.max(14, Math.round((image.height * scale) / 14) * 14)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height),
    result = await runImageWorker(
      new URL('./depth-worker.js', import.meta.url),
      { pixels },
      [pixels.data.buffer],
      async (input) => (await import('./depth-kernel.js')).inferDepth(input)
    )
  return {
    raster: encodeSoftMask(result),
    provenance: {
      ...result.provenance,
      sourceWidth: image.width,
      sourceHeight: image.height,
      inputWidth: canvas.width,
      inputHeight: canvas.height
    },
    metrics: result.metrics
  }
}
