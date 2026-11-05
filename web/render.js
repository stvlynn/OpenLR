import { analyzeDehazeOwned, encodeDehaze } from './dehaze-worker-client.js'
import { analyzeDehaze, createDehazePixel } from './dehaze.js'
import { geometry } from './geometry.js'
import { filledSource, filledFrame } from './fill.js'
import { correctEyes, correctEyesFrame } from './culling.js'
import { renderLocalSource, applyLocalTools } from './local-tools.js'
import { renderOpticsSource, warpOpticsFrame } from './optics.js'
import {
  createMixer,
  spatialEffects,
  toneCurve,
  createGlobalTone,
  createFloatMixer,
  createFloatToneCurve,
  spatialEffectsFloat
} from './color.js'
import { globalToneParameters, globalToneRgb } from './tone.js'
import { assertLinearFrame, linearFrameToRgba8, rgba8ToLinearFrame, isLinearFrame } from './pixel-frame.js'
import { transformFrame } from './frame-geometry.js'
import { workingFrame } from './working-frames.js'
import { processingVersion, PROCESS_MESSAGES } from './process-version.js'
import { controls } from './adjustments.js'
import { createPointCurves, createPointCurveTables } from './tone-curves.js'
import { createColorGrading } from './color-grading.js'
import { SRGB8_LINEAR as linear } from './color-spaces.js'
export { controls } from './adjustments.js'
function encode(v) {
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
}
function sourceStages(image, edit, stages) {
  let result = image
  for (const name of ['fill', 'eyes', 'local', 'optics']) result = stages[name](result, edit)
  return result
}

// Original decoded frames and ImageBitmaps are immutable. Keep only the latest
// source-correction revision per source; crop, output size and strength reuse it.
const dehazeSources = new WeakMap()
const sourceKey = (edit) => JSON.stringify([edit.fills, edit.redEyes, edit.localTools, edit.optics])
const cacheableSource = (image) =>
  isLinearFrame(image) || (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap)
const canceledPreparation = () =>
  Object.assign(new Error('Image processing canceled'), { name: 'AbortError', code: 'ABORTED' })
function needsAnalysis(entry, edit) {
  return (
    !entry.analysis ||
    (edit.Dehaze > 0 && entry.analysis.visible && !entry.analysis.black && !entry.analysis.transmission)
  )
}
function dehazedSource(image, edit, prepare) {
  const cacheable = cacheableSource(image)
  const key = sourceKey(edit)
  let entry = cacheable ? dehazeSources.get(image) : null
  if (!entry || entry.key !== key || entry.pending || entry.controller?.signal.aborted) {
    entry = { key, source: prepare(), analysis: null }
    if (cacheable) dehazeSources.set(image, entry)
  }
  if (
    !entry.analysis ||
    (edit.Dehaze > 0 && entry.analysis.visible && !entry.analysis.black && !entry.analysis.transmission)
  )
    entry.analysis = analyzeDehaze(entry.source, { transmission: edit.Dehaze > 0 })
  return entry
}
function correctedFrame(image, edit) {
  const owned = { ...image, data: image.data.slice() }
  return sourceStages(owned, edit, {
    fill: (input) => filledFrame(input, edit.fills),
    eyes: (input) => correctEyesFrame(input, edit.redEyes),
    local: (input) => applyLocalTools(input, edit.localTools),
    optics: (input) => warpOpticsFrame(input, edit.optics, image)
  })
}
function correctedBitmap(image, edit, edge) {
  return sourceStages(image, edit, {
    fill: (input) => filledSource(input, edit.fills, edge),
    eyes: (input) => correctEyes(input, edit.redEyes, edge),
    local: (input) => renderLocalSource(input, edit.localTools, edge),
    optics: (input) => renderOpticsSource(input, edit.optics, image, edge)
  })
}

function correctedByteFrame(image, edit) {
  return rgba8ToLinearFrame(correctedBytePixels(image, edit))
}
function correctedBytePixels(image, edit) {
  const corrected = correctedBitmap(image, edit, Infinity)
  const full = document.createElement('canvas')
  full.width = corrected.width
  full.height = corrected.height
  const context = full.getContext('2d', { willReadFrequently: true })
  context.drawImage(corrected, 0, 0)
  return context.getImageData(0, 0, full.width, full.height)
}
async function consumePreparation(entry, signal) {
  if (signal?.aborted) throw canceledPreparation()
  const consumer = {}
  entry.consumers.add(consumer)
  let abort
  const canceled = new Promise((_, reject) => {
    abort = () => reject(canceledPreparation())
    signal?.addEventListener('abort', abort, { once: true })
  })
  try {
    await Promise.race([entry.pending, canceled])
  } finally {
    signal?.removeEventListener('abort', abort)
    entry.consumers.delete(consumer)
    // A new strength request can join before a superseded preview relinquishes
    // the last claim. Explicit thumbnail/export consumers keep the job alive.
    queueMicrotask(() => {
      if (entry.pending && !entry.consumers.size) entry.controller.abort()
    })
  }
}
export async function prepareDehaze(image, edit = {}, { signal } = {}) {
  if (signal?.aborted) throw canceledPreparation()
  if (!edit.Dehaze) return null
  const original = processingVersion(edit) === 2 && !isLinearFrame(image) ? workingFrame(image) : image
  if (!original) throw Error(PROCESS_MESSAGES.missingSource)
  const key = sourceKey(edit),
    cacheable = cacheableSource(original)
  let entry = cacheable ? dehazeSources.get(original) : null
  if (!entry || entry.key !== key || entry.controller?.signal.aborted) {
    entry = {
      key,
      source: isLinearFrame(original) ? correctedFrame(original, edit) : correctedBytePixels(original, edit),
      analysis: null,
      consumers: new Set()
    }
    if (cacheable) dehazeSources.set(original, entry)
  }
  entry.consumers ??= new Set()
  while (entry.pending || needsAnalysis(entry, edit)) {
    if (!entry.pending) {
      entry.controller = new AbortController()
      // A ready negative-only source may still be read by another consumer.
      // Upgrade from an owned copy; never detach a published cache snapshot.
      const owned = entry.analysis ? { ...entry.source, data: entry.source.data.slice() } : entry.source
      entry.pending = analyzeDehazeOwned(owned, {
        encoding: isLinearFrame(owned) ? 'linear' : 'rgba8',
        transmission: edit.Dehaze > 0,
        signal: entry.controller.signal
      })
        .then(({ frame, analysis }) => {
          entry.source = frame
          entry.analysis = analysis
        })
        .catch((error) => {
          if (cacheable && dehazeSources.get(original) === entry) dehazeSources.delete(original)
          throw error
        })
        .finally(() => {
          entry.pending = null
        })
    }
    await consumePreparation(entry, signal)
    if (signal?.aborted) throw canceledPreparation()
  }
  return { source: entry.source, analysis: entry.analysis }
}
export async function renderPrepared(image, edit = {}, maxSize = Infinity, options = {}) {
  const prepared = await prepareDehaze(image, edit, options)
  if (options.signal?.aborted) throw canceledPreparation()
  if (prepared && processingVersion(edit) !== 2) {
    const { pixels } = await encodeDehaze(prepared.source, prepared.analysis, edit.Dehaze, options)
    if (options.signal?.aborted) throw canceledPreparation()
    return render(image, edit, maxSize, { ...prepared, pixels })
  }
  return render(image, edit, maxSize, prepared)
}
export async function renderFramePrepared(image, edit = {}, maxSize = Infinity, options = {}) {
  const prepared = await prepareDehaze(image, edit, options)
  if (options.signal?.aborted) throw canceledPreparation()
  return renderFrame(image, edit, maxSize, prepared)
}

export function renderFrame(image, edit = {}, maxSize = Infinity, ready = null) {
  assertLinearFrame(image)
  // A render owns its mutable pixels. Cached originals never become edit state.
  const prepared = edit.Dehaze
    ? (ready ?? dehazedSource(image, edit, () => correctedFrame(image, edit)))
    : null
  const frame = prepared
    ? transformFrame(prepared.source, edit, maxSize, image, createDehazePixel(edit.Dehaze, prepared.analysis))
    : transformFrame(correctedFrame(image, edit), edit, maxSize, image)
  const tone = createGlobalTone(edit),
    curve = createFloatToneCurve(edit),
    points = createPointCurves(edit),
    mixer = createFloatMixer(edit),
    grading = createColorGrading(edit)
  for (let i = 0; i < frame.data.length; i += 4) {
    tone?.(frame.data, i)
    if (curve) for (let c = 0; c < 3; c++) frame.data[i + c] = curve(frame.data[i + c])
    if (points) for (let c = 0; c < 3; c++) frame.data[i + c] = points(frame.data[i + c], c)
    mixer?.(frame.data, i)
    grading?.(frame.data, i)
  }
  spatialEffectsFloat(frame.data, frame.width, frame.height, edit)
  return assertLinearFrame(frame)
}

export function frameCanvas(frame, readPixel = null) {
  return pixelsCanvas(linearFrameToRgba8(frame, readPixel))
}

function pixelsCanvas(pixels) {
  const canvas = document.createElement('canvas')
  canvas.width = pixels.width
  canvas.height = pixels.height
  canvas.getContext('2d').putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0)
  return canvas
}

export function render(image, edit = {}, maxSize = Infinity, ready = null) {
  if (processingVersion(edit) === 2) {
    const frame = workingFrame(image)
    if (!frame) throw new Error(PROCESS_MESSAGES.missingSource)
    return frameCanvas(renderFrame(frame, edit, maxSize, ready))
  }
  const canvas = document.createElement('canvas')
  const geom = geometry(image, edit, maxSize)
  const { x, y, w, h, width, height, turn, flip } = geom
  const sourceEdge = Math.max((width * image.width) / w, (height * image.height) / h)
  let localSource
  if (edit.Dehaze) {
    const prepared = ready ?? dehazedSource(image, edit, () => correctedByteFrame(image, edit))
    localSource = prepared.pixels
      ? pixelsCanvas(prepared.pixels)
      : frameCanvas(prepared.source, createDehazePixel(edit.Dehaze, prepared.analysis))
  } else localSource = correctedBitmap(image, edit, sourceEdge)
  const sourceScaleX = localSource.width / image.width,
    sourceScaleY = localSource.height / image.height
  canvas.width = turn % 2 ? height : width
  canvas.height = turn % 2 ? width : height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((turn * Math.PI) / 2)
  ctx.scale(flip ? -1 : 1, 1)
  ctx.drawImage(
    localSource,
    x * sourceScaleX,
    y * sourceScaleY,
    w * sourceScaleX,
    h * sourceScaleY,
    -width / 2,
    -height / 2,
    width,
    height
  )
  const pointTables = createPointCurveTables(edit),
    grading = createColorGrading(edit)
  if (
    !pointTables &&
    !grading &&
    !edit.pointColors?.length &&
    !Object.values(controls).some((group) => Object.keys(group).some((key) => edit[key]))
  )
    return canvas
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height),
    data = pixels.data
  const parameters = globalToneParameters(edit, { legacy: true })
  const { redGain, greenGain, blueGain, slope, shadows, lights, white, black, sat, vib } = parameters
  const mixer = createMixer(edit),
    curve = toneCurve(edit)
  if (!shadows && !lights && !white && !black && !sat && !vib) {
    if (redGain !== 1 || greenGain !== 1 || blueGain !== 1 || slope !== 1) {
      const [red, green, blue] = [redGain, greenGain, blueGain].map((channelGain) =>
        Uint8ClampedArray.from(linear, (v) => encode((v * channelGain - 0.18) * slope + 0.18))
      )
      for (let i = 0; i < data.length; i += 4) {
        data[i] = red[data[i]]
        data[i + 1] = green[data[i + 1]]
        data[i + 2] = blue[data[i + 2]]
      }
    }
  } else {
    const output = new Float64Array(3)
    for (let i = 0; i < data.length; i += 4) {
      globalToneRgb(linear[data[i]], linear[data[i + 1]], linear[data[i + 2]], parameters, output)
      for (let c = 0; c < 3; c++) data[i + c] = encode(output[c])
    }
  }
  if (curve)
    for (let i = 0; i < data.length; i += 4) for (let k = 0; k < 3; k++) data[i + k] = curve[data[i + k]]
  if (pointTables)
    for (let i = 0; i < data.length; i += 4)
      for (let k = 0; k < 3; k++) data[i + k] = pointTables[k][data[i + k]]
  if (mixer) for (let i = 0; i < data.length; i += 4) mixer(data, i)
  if (grading) {
    const pixel = new Float64Array(3)
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) pixel[c] = linear[data[i + c]]
      grading(pixel)
      for (let c = 0; c < 3; c++) data[i + c] = encode(pixel[c])
    }
  }
  spatialEffects(data, canvas.width, canvas.height, edit)
  ctx.putImageData(pixels, 0, 0)
  return canvas
}
export function toBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image export failed'))), type, quality)
  )
}
