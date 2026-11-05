import { filledFrame, filledSource } from './fill.js'
import { correctEyesFrame, correctEyes } from './culling.js'
import { applyLocalTools } from './local-tools.js'
import { processingVersion, PROCESS_MESSAGES } from './process-version.js'
import { workingFrame } from './working-frames.js'

export function sourceBeforeLocalFrame(frame, edit) {
  return correctEyesFrame(filledFrame(frame, edit.fills), edit.redEyes)
}

export function sourceBeforeLocalBitmap(image, edit, maxEdge = Infinity) {
  return correctEyes(filledSource(image, edit.fills, maxEdge), edit.redEyes, maxEdge)
}

export function readSourcePixels(image, maxEdge = Infinity, canvas = document.createElement('canvas')) {
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height))
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

// Range coverage reads the same source stages as rendering, before blur or masks.
export function maskReference(image, edit, maxEdge = Infinity, canvas) {
  const repairs = edit.localTools?.repairs
  if (processingVersion(edit) === 2) {
    const frame = workingFrame(image)
    if (!frame) throw Error(PROCESS_MESSAGES.missingSource)
    const corrected = sourceBeforeLocalFrame({ ...frame, data: frame.data.slice() }, edit)
    return applyLocalTools(corrected, { repairs })
  }
  const pixels = readSourcePixels(sourceBeforeLocalBitmap(image, edit, maxEdge), maxEdge, canvas)
  return applyLocalTools(pixels, { repairs })
}
