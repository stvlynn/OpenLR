import { renderPrepared as render, toBlob } from './render.js'
import { runImageWorker } from './image-worker.js'
export async function enhancePhoto(image, edit, { mode = 'denoise', strength = 1 } = {}) {
  const canvas = await render(image, edit),
    pixels = canvas
      .getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height)
  const result = await runImageWorker(
    new URL('./enhance-worker.js', import.meta.url),
    { pixels, mode, strength },
    [pixels.data.buffer],
    async (args) => (await import('./enhance-kernel.js')).processEnhance(args)
  )
  const output = document.createElement('canvas')
  output.width = result.width
  output.height = result.height
  output.getContext('2d').putImageData(new ImageData(result.data, result.width, result.height), 0, 0)
  const blob = await toBlob(output, 'image/png')
  return {
    blob,
    width: result.width,
    height: result.height,
    thumbnail: await toBlob(await render(output, {}, 240)),
    provenance: result.provenance,
    metrics: result.metrics
  }
}
