import { filledSource } from './fill.js'
import { runImageWorker } from './image-worker.js'
import { usesPixelRange } from './local-tools.js'
import { maskReference, readSourcePixels } from './source-corrections.js'

export async function removeMaskedArea(image, recipe, mask, algorithm, radius) {
  // The stored patch is composited before red-eye and repairs. Use the later
  // color reference to select pixels without baking those corrections twice.
  const pixels = readSourcePixels(filledSource(image, recipe.fills)),
    reference = usesPixelRange(mask) ? maskReference(image, recipe) : null,
    transfers = [pixels.data.buffer]
  if (reference) transfers.push(reference.data.buffer)
  const { patch } = await runImageWorker(
    new URL('./inpaint-worker.js', import.meta.url),
    { pixels, reference, mask, algorithm, radius },
    transfers,
    async (args) => (await import('./inpaint-kernel.js')).makeFill(args)
  )
  return {
    ...recipe,
    fills: [...(recipe.fills || []), patch],
    localTools: { ...recipe.localTools, masks: recipe.localTools.masks.filter((m) => m.id !== mask.id) }
  }
}
