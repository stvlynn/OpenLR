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
import { assertLinearFrame, linearFrameToRgba8 } from './pixel-frame.js'
import { transformFrame } from './frame-geometry.js'
import { workingFrame } from './working-frames.js'
import { processingVersion, PROCESS_MESSAGES } from './process-version.js'
import { controls } from './adjustments.js'
import { createPointCurves, createPointCurveTables } from './tone-curves.js'
import { createColorGrading } from './color-grading.js'
export { controls } from './adjustments.js'
const linear = Float64Array.from({ length: 256 }, (_, i) => {
  const v = i / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
})
function encode(v) {
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
}
function sourceStages(image, edit, stages) {
  let result = image
  for (const name of ['fill', 'eyes', 'local', 'optics']) result = stages[name](result, edit)
  return result
}

export function renderFrame(image, edit = {}, maxSize = Infinity) {
  assertLinearFrame(image)
  // A render owns its mutable pixels. Cached originals never become edit state.
  const owned = { ...image, data: image.data.slice() }
  const source = sourceStages(owned, edit, {
    fill: (input) => filledFrame(input, edit.fills),
    eyes: (input) => correctEyesFrame(input, edit.redEyes),
    local: (input) => applyLocalTools(input, edit.localTools),
    optics: (input) => warpOpticsFrame(input, edit.optics, image)
  })
  const frame = transformFrame(source, edit, maxSize, image)
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

export function frameCanvas(frame) {
  const pixels = linearFrameToRgba8(frame),
    canvas = document.createElement('canvas')
  canvas.width = pixels.width
  canvas.height = pixels.height
  canvas.getContext('2d').putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0)
  return canvas
}

export function render(image, edit = {}, maxSize = Infinity) {
  if (processingVersion(edit) === 2) {
    const frame = workingFrame(image)
    if (!frame) throw new Error(PROCESS_MESSAGES.missingSource)
    return frameCanvas(renderFrame(frame, edit, maxSize))
  }
  const canvas = document.createElement('canvas')
  const geom = geometry(image, edit, maxSize)
  const { x, y, w, h, width, height, turn, flip } = geom
  const sourceEdge = Math.max((width * image.width) / w, (height * image.height) / h)
  const localSource = sourceStages(image, edit, {
    fill: (input) => filledSource(input, edit.fills, sourceEdge),
    eyes: (input) => correctEyes(input, edit.redEyes, sourceEdge),
    local: (input) => renderLocalSource(input, edit.localTools, sourceEdge),
    optics: (input) => renderOpticsSource(input, edit.optics, image, sourceEdge)
  })
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
