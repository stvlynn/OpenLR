import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createGlobalTone,
  globalToneParameters,
  globalToneRgb,
  createFloatMixer,
  createFloatToneCurve,
  spatialEffectsFloat,
  createMixer,
  toneCurve,
  spatialEffects
} from '../web/color.js'
import { decodeSrgb, encodeSrgb } from '../web/color-spaces.js'

function near(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)
}
function apply(data, operation) {
  if (operation) for (let i = 0; i < data.length; i += 4) operation(data, i)
  return data
}

test('global tone retains sub-byte differences, signed RGB, recovered highlights and alpha', () => {
  const original = Float32Array.from([0.20001, -0.03, 4, 0.37, 0.20002, 0.4, 8, 0])
  assert.equal(Math.round(encodeSrgb(original[0]) * 255), Math.round(encodeSrgb(original[4]) * 255))
  const data = original.slice()
  apply(data, createGlobalTone({ Exposure: 4 }))
  assert.ok(data[2] > 1)
  apply(data, createGlobalTone({ Exposure: -4 }))
  data.forEach((value, i) => near(value, original[i]))
  assert.notEqual(data[0], data[4])
  assert.equal(data[3], original[3])
  assert.equal(data[7], 0)
  assert.equal(createGlobalTone({}), null)
  assert.equal(createGlobalTone({ Grain: 20 }), null)
})

test('global white balance, contrast, tonal weights and color use one unclipped rule', () => {
  const affine = globalToneRgb(
    -0.2,
    0.4,
    4,
    globalToneParameters({
      Exposure: -1,
      Temperature: 50,
      Tint: -20,
      Contrast: 30
    })
  )
  near(affine[0], (-0.2 * 0.5 * 2 ** 0.5 - 0.18) * 2 ** 0.3 + 0.18)
  near(affine[1], (0.4 * 0.5 * 2 ** 0.1 - 0.18) * 2 ** 0.3 + 0.18)
  near(affine[2], (4 * 0.5 * 2 ** -0.5 - 0.18) * 2 ** 0.3 + 0.18)
  assert.ok(affine[0] < 0)
  assert.ok(affine[2] > 1)
  const edit = { Shadows: 30, Highlights: -25, Whites: -20, Blacks: 15, Saturation: 12, Vibrance: 33 }
  const data = Float32Array.from([-0.3, 0.4, 2.5, 0.25])
  const expected = globalToneRgb(...data.slice(0, 3), globalToneParameters(edit))
  apply(data, createGlobalTone(edit))
  expected.forEach((value, i) => near(data[i], value))
  assert.ok(data[0] < 0)
  assert.ok(data[2] > 1)
  assert.equal(data[3], 0.25)
  // Bounded influence avoids polynomial blowup on negative luminance.
  const negative = globalToneRgb(-2, -3, -4, globalToneParameters({ Shadows: 100, Highlights: 100 }))
  negative.forEach((value, i) => near(value, [-2, -3, -4][i]))
})

test('tone curve interpolates continuously with identity signed/highlight extension', () => {
  const curve = createFloatToneCurve({ 'Curve shadows': 20, 'Curve midtones': -13, 'Curve lights': 28 })
  const encoded = 0.40001,
    encoded2 = 0.40002
  assert.equal(Math.round(encoded * 255), Math.round(encoded2 * 255))
  const a = curve(decodeSrgb(encoded)),
    b = curve(decodeSrgb(encoded2))
  assert.notEqual(Math.fround(a), Math.fround(b))
  const expected = (80 + (encoded * 4 - 1) * (117.6 - 80)) / 255
  near(a, decodeSrgb(expected), 1e-12)
  assert.equal(curve(-0.3), -0.3)
  assert.equal(curve(3.2), 3.2)
  assert.equal(curve(0), 0)
  assert.equal(curve(1), 1)
  assert.equal(createFloatToneCurve({}), null)
})

test('float HSL changes selected colors without collapsing HDR envelope or unselected values', () => {
  const data = Float32Array.from([2, -0.1, -0.1, 0.3, -0.03, 0.01, 2, 0.7])
  const original = data.slice()
  apply(data, createFloatMixer({ 'Red Hue': 60 }))
  assert.ok(data[0] > 1)
  assert.ok(data[1] > original[1])
  assert.ok(data[2] < 0)
  assert.equal(data[3], original[3])
  assert.deepEqual(data.slice(4), original.slice(4))
  const a = Float32Array.from([decodeSrgb(0.80001), decodeSrgb(0.15), decodeSrgb(0.1), 0]),
    b = a.slice()
  b[0] = decodeSrgb(0.80002)
  const mixer = createFloatMixer({ 'Red Saturation': -20, 'Red Luminance': 15 })
  apply(a, mixer)
  apply(b, mixer)
  assert.notEqual(a[0], b[0])
  assert.equal(a[3], 0)
  assert.equal(createFloatMixer({}), null)
})

test('float point color uses encoded swatch selection and leaves unmatched HDR pixels exact', () => {
  const data = Float32Array.from([
    decodeSrgb(208 / 255),
    decodeSrgb(64 / 255),
    decodeSrgb(32 / 255),
    0.5,
    -0.12,
    0.7,
    4,
    1
  ])
  const original = data.slice()
  apply(
    data,
    createFloatMixer({
      pointColors: [{ color: '#d04020', range: 30, hue: 90, saturation: 20, luminance: -10 }]
    })
  )
  assert.ok(data[1] > data[0])
  assert.equal(data[3], 0.5)
  assert.deepEqual(data.slice(4), original.slice(4))
})

test('linear spatial effects keep signed HDR, sub-byte samples and straight alpha', () => {
  const source = Float32Array.from([2.00001, -0.2, 0.4, 1, 2.00002, -0.19999, 0.40001, 1])
  const data = source.slice()
  const edit = { Sharpening: 20, 'Noise reduction': 10, Clarity: 20, Texture: 10, Grain: 10, Vignette: -20 }
  spatialEffectsFloat(data, 2, 1, edit)
  assert.ok(data[0] > 1 && data[4] > 1)
  assert.ok(data[1] < 0 && data[5] < 0)
  assert.notEqual(data[0], data[4])
  assert.equal(data[3], 1)
  assert.equal(data[7], 1)
  const repeated = source.slice()
  spatialEffectsFloat(repeated, 2, 1, edit)
  assert.deepEqual(data, repeated)
  const perturbed = source.slice()
  perturbed[0] += 0.00001
  spatialEffectsFloat(perturbed, 2, 1, edit)
  assert.notEqual(data[0], perturbed[0])
  const transparent = Float32Array.from([0.2, 0.3, 0.4, 1, 1000, -100, 20, 0])
  spatialEffectsFloat(transparent, 2, 1, { 'Noise reduction': 100, Clarity: 100 })
  near(transparent[0], 0.2)
  near(transparent[1], 0.3)
  near(transparent[2], 0.4)
  assert.equal(transparent[3], 1)
  assert.equal(transparent[7], 0)
})

test('legacy curve, mixer and spatial effects retain the captured byte result', () => {
  // Captured from the original kernels before extraction, not regenerated by
  // the implementation under test. Includes partial/zero alpha and grain.
  const edit = {
    'Red Hue': 17,
    'Blue Saturation': -36,
    'Curve shadows': 20,
    'Curve midtones': -13,
    'Curve lights': 28,
    pointColors: [{ color: '#d04020', range: 70, hue: 34, saturation: 16, luminance: -18 }],
    Sharpening: 35,
    'Noise reduction': 20,
    Vignette: -31,
    Grain: 22,
    Clarity: 23,
    Texture: -12
  }
  const pixels = Uint8ClampedArray.from([
    208, 64, 32, 255, 32, 64, 208, 128, 2, 5, 15, 0, 245, 180, 130, 255, 12, 160, 90, 80, 240, 240, 240, 200
  ])
  const curve = toneCurve(edit),
    mixer = createMixer(edit)
  for (let i = 0; i < pixels.length; i += 4) {
    for (let k = 0; k < 3; k++) pixels[i + k] = curve[pixels[i + k]]
    mixer(pixels, i)
  }
  spatialEffects(pixels, 3, 2, edit)
  assert.deepEqual(
    [...pixels],
    [212, 177, 0, 255, 59, 71, 233, 128, 0, 0, 0, 0, 247, 222, 94, 255, 0, 157, 92, 80, 250, 244, 246, 200]
  )
})
