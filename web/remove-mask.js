import { runImageWorker } from './image-worker.js'
import { resolveRepairAnchors, usesPixelRange } from './local-tools.js'
import { isLinearFrame, linearFrameToRgba8 } from './pixel-frame.js'
import { maskReference } from './source-corrections.js'

export async function removeMaskedArea(image, recipe, mask, algorithm, radius) {
  // Both selection and inpainting read the raster where the patch will land.
  // Only the RGB solver's input is quantized in Linear.
  const corrected = maskReference(image, recipe),
    isLinear = isLinearFrame(corrected),
    pixels = isLinear ? linearFrameToRgba8(corrected) : corrected,
    reference = isLinear && usesPixelRange(mask) ? corrected : undefined,
    transfers = [pixels.data.buffer]
  if (reference) transfers.push(reference.data.buffer)
  const { patch } = await runImageWorker(
    new URL('./inpaint-worker.js', import.meta.url),
    { pixels, reference, mask, algorithm, radius },
    transfers,
    async (args) => (await import('./inpaint-kernel.js')).makeFill(args)
  )
  const localTools = {
    ...recipe.localTools,
    masks: recipe.localTools.masks.filter((m) => m.id !== mask.id)
  }
  // Keep orphaned repairs at the position used for this solve. The newly
  // appended patch must follow them, even after a selective paste.
  if (localTools.repairs?.length)
    localTools.repairs = resolveRepairAnchors(localTools.repairs, recipe.postRepairFills)
  return {
    ...recipe,
    postRepairFills: [...(recipe.postRepairFills || []), { ...patch, id: crypto.randomUUID() }],
    localTools
  }
}
