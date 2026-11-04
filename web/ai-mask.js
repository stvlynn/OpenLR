import { AI_TARGETS, modelFor } from './ai-models.js'
import { runImageWorker } from './image-worker.js'
import { encodeSoftMask } from './soft-mask.js'

export async function generateAiMask(image, { target = 'subject', adjustments = {} } = {}) {
  if (!AI_TARGETS.includes(target)) throw Error('Unsupported semantic target')
  const model = modelFor(target),
    canvas = document.createElement('canvas')
  if (target === 'sky') {
    // DETR keeps aspect ratio; the speed/coverage experiment is recorded in research/ai/.
    const scale = Math.min(
      model.shortEdge / Math.min(image.width, image.height),
      model.maxEdge / Math.max(image.width, image.height)
    )
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))
  } else {
    canvas.width = model.width
    canvas.height = model.height
  }
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const result = await runImageWorker(
    new URL('./ai-worker.js', import.meta.url),
    { pixels, target },
    [pixels.data.buffer],
    async (input) => (await import('./ai-kernel.js')).inferSemantic(input)
  )
  return {
    mask: {
      type: 'semantic',
      raster: encodeSoftMask(result),
      opacity: 1,
      feather: 0,
      invert: false,
      enabled: true,
      adjustments,
      provenance: {
        ...result.provenance,
        sourceWidth: image.width,
        sourceHeight: image.height,
        inputWidth: canvas.width,
        inputHeight: canvas.height,
        created: new Date().toISOString()
      }
    },
    metrics: result.metrics
  }
}
