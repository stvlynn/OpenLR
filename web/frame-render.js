import { createDehazePixel } from './dehaze.js'
import { transformFrame } from './frame-geometry.js'
import { assertLinearFrame } from './pixel-frame.js'
import { createGlobalTone, createFloatToneCurve, createFloatMixer, spatialEffectsFloat } from './color.js'
import { createPointCurves } from './tone-curves.js'
import { createColorGrading } from './color-grading.js'

// The source already includes fill, eye, local and optics corrections. Geometry
// creates the dehazed output; neutral geometry may retain the caller-owned frame.
export function renderCorrectedFrame(source, edit, maxSize, reference = source, analysis = null) {
  const frame = transformFrame(
    source,
    edit,
    maxSize,
    reference,
    analysis ? createDehazePixel(edit.Dehaze, analysis) : null
  )
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
