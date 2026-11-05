import {
  filledFrame,
  filledSource,
  fillOwnedFrame,
  fillOwnedPixels,
  validatePostRepairFills
} from './fill.js'
import { correctEyesFrame, correctEyes } from './culling.js'
import { applyLocalMasks, applyLocalRepairs, resolveRepairAnchors } from './local-tools.js'
import { processingVersion, PROCESS_MESSAGES } from './process-version.js'
import { workingFrame } from './working-frames.js'

export function sourceBeforeMasksFrame(frame, edit) {
  const corrected = correctEyesFrame(filledFrame(frame, edit.fills), edit.redEyes)
  return applyRetouch(corrected, edit, fillOwnedFrame)
}

function sourceBeforeLocalBitmap(image, edit, maxEdge) {
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

function sourceBeforeMasksPixels(image, edit, maxEdge, canvas) {
  const pixels = readSourcePixels(image, maxEdge, canvas)
  return applyRetouch(pixels, edit, fillOwnedPixels)
}

function applyRetouch(pixels, edit, fillOwned) {
  const repairs = edit.localTools?.repairs,
    fills = edit.postRepairFills
  if (!fills?.length) return applyLocalRepairs(pixels, repairs)
  validatePostRepairFills(fills)
  const byFill = new Map()
  for (const repair of resolveRepairAnchors(repairs ?? [], fills)) {
    if (!byFill.has(repair.afterFillId)) byFill.set(repair.afterFillId, [])
    byFill.get(repair.afterFillId).push(repair)
  }
  applyLocalRepairs(pixels, byFill.get(undefined))
  for (const fill of fills) {
    fillOwned(pixels, [fill])
    applyLocalRepairs(pixels, byFill.get(fill.id))
  }
  return pixels
}

export function renderLocalBitmap(image, edit, maxEdge) {
  const corrected = sourceBeforeLocalBitmap(image, edit, maxEdge),
    local = edit.localTools ?? undefined
  if (
    !edit.postRepairFills?.length &&
    !local?.lensBlur?.enabled &&
    ![...(local?.masks ?? []), ...(local?.repairs ?? [])].some(
      (tool) => tool.enabled !== false && tool.opacity
    )
  )
    return corrected
  const canvas = document.createElement('canvas'),
    pixels = sourceBeforeMasksPixels(corrected, edit, maxEdge, canvas)
  canvas.getContext('2d').putImageData(applyLocalMasks(pixels, local), 0, 0)
  return canvas
}

// Range coverage reads the same source stages as rendering, before blur or masks.
export function maskReference(image, edit, maxEdge = Infinity, canvas) {
  if (processingVersion(edit) === 2) {
    const frame = workingFrame(image)
    if (!frame) throw Error(PROCESS_MESSAGES.missingSource)
    return sourceBeforeMasksFrame({ ...frame, data: frame.data.slice() }, edit)
  }
  return sourceBeforeMasksPixels(sourceBeforeLocalBitmap(image, edit, maxEdge), edit, maxEdge, canvas)
}
