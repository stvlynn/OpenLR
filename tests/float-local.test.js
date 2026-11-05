import test from 'node:test'
import assert from 'node:assert/strict'
import { applyLocalTools, validateLocalTool } from '../web/local-tools.js'
import { applyLensBlur, validateDepthSettings } from '../web/depth-effects.js'
import { rangeWeight } from '../web/range-masks.js'
import { encodeSoftMask } from '../web/soft-mask.js'

const frame = (width, samples) => ({
  width,
  height: samples.length / (width * 4),
  data: Float32Array.from(samples),
  colorSpace: 'srgb-linear'
})
const pixel = (image, x) => Array.from(image.data.slice(x * 4, x * 4 + 4))
const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)
const fullMask = (adjustments, opacity = 1) =>
  validateLocalTool('mask', {
    type: 'radial',
    center: { x: 0.5, y: 0.5 },
    rx: 1,
    ry: 1,
    feather: 0,
    opacity,
    adjustments
  })
const repair = (type, source, points, opacity = 1) =>
  validateLocalTool('repair', { type, source, points, radius: 0.49, feather: 0, opacity })
const raster = (values) => encodeSoftMask({ width: values.length, height: 1, mask: Uint8Array.from(values) })
const focus = validateDepthSettings({ amount: 0.15, min: 0.4, max: 0.6, softness: 0 })

test('float local exposure recovers signed highlights and sub-byte differences without changing alpha', () => {
  const image = frame(2, [-0.25, 3.5, 0.20001, 0.125, -0.25001, 3.5001, 0.20002, 0.75]),
    original = image.data.slice()
  applyLocalTools(image, { masks: [fullMask({ Exposure: 4 }), fullMask({ Exposure: -4 })] })
  for (let i = 0; i < original.length; i++) close(image.data[i], original[i])
  assert.notEqual(image.data[2], image.data[6])
  assert.equal(image.data[3], original[3])
  assert.equal(image.data[7], original[7])
  const adjusted = frame(1, [-0.25, 4, 0.20001, 0.3]),
    before = Array.from(adjusted.data),
    settings = { Exposure: -1, Contrast: 50, Saturation: -40 },
    gain = 0.5,
    contrast = Math.sqrt(2),
    channels = before.slice(0, 3).map((v) => v * gain),
    luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  applyLocalTools(adjusted, { masks: [fullMask(settings, 0.25)] })
  for (let c = 0; c < 3; c++) {
    const target = (luminance - 0.18) * contrast + 0.18 + (channels[c] - luminance) * 0.6 * contrast
    close(adjusted.data[c], before[c] * 0.75 + target * 0.25)
  }
  assert.equal(adjusted.data[3], before[3])
})

test('float clone interpolates and composites premultiplied linear colors without transparent color bleed', () => {
  const samples = [-0.4, 3.5, 0.20001, 0.25, 500, -700, 90, 0, 8, -2, 0.3, 1, 0, 0, 0, 1],
    image = frame(4, samples),
    clone = repair('clone', { x: 0.25, y: 0.5 }, [{ x: 0.625, y: 0.5 }])
  applyLocalTools(image, { repairs: [clone] })
  for (let c = 0; c < 3; c++) close(image.data[8 + c], Math.fround(samples[c]))
  close(image.data[11], 0.125)
  assert.deepEqual(pixel(image, 0), Array.from(Float32Array.from(samples.slice(0, 4))))
  const mixed = frame(4, samples)
  applyLocalTools(mixed, { repairs: [{ ...clone, opacity: 0.5 }] })
  const alpha = 0.5 + 0.125 * 0.5
  close(mixed.data[11], alpha)
  for (let c = 0; c < 3; c++)
    close(mixed.data[8 + c], (samples[8 + c] * 0.5 + samples[c] * 0.125 * 0.5) / alpha)
})

test('float clone reads an immutable pre-stroke image while strokes remain sequential', () => {
  const values = [-0.2, 1.0001, 2.0002, 3.0003, 4.0004],
    image = frame(
      5,
      values.flatMap((v) => [v, v, v, 1])
    ),
    original = image.data.slice(),
    stroke = repair('clone', { x: 0.1, y: 0.5 }, [
      { x: 0.3, y: 0.5 },
      { x: 0.9, y: 0.5 }
    ])
  applyLocalTools(image, { repairs: [stroke] })
  for (let x = 1; x < 5; x++) close(image.data[x * 4], original[(x - 1) * 4])
  applyLocalTools(image, { repairs: [stroke] })
  close(image.data[8], original[0])
})

test('float heal uses an unclipped linear residual and preserves source texture below a byte step', () => {
  const image = frame(
      5,
      [-1, -3, 2.0001, 1, 3, 5, 2.0002, 1, 0, 0, 0, 1, 5, -1, 4.0001, 1, 5, -1, 4.0001, 1]
    ),
    before = image.data.slice(),
    stroke = repair('heal', { x: 0.1, y: 0.5 }, [
      { x: 0.7, y: 0.5 },
      { x: 0.9, y: 0.5 }
    ])
  applyLocalTools(image, { repairs: [stroke] })
  close(image.data[12], 3)
  close(image.data[16], 7)
  close(image.data[13], -5)
  close(image.data[17], 3)
  close(image.data[18] - image.data[14], before[6] - before[2])
  assert.notEqual(image.data[18], image.data[14])
  assert.deepEqual(image.data.slice(0, 12), before.slice(0, 12))
})

test('float ranges use unquantized encoded-sRGB selection and direct unbounded linear luminance', () => {
  const color = validateLocalTool('mask', {
      type: 'color-range',
      color: '#808080',
      tolerance: 0.00001,
      softness: 0,
      adjustments: { Exposure: 1 }
    }),
    encoded = 128 / 255,
    linear = ((encoded + 0.055) / 1.055) ** 2.4,
    nearby = ((encoded + 0.0002 + 0.055) / 1.055) ** 2.4,
    image = frame(2, [linear, linear, linear, 1, nearby, nearby, nearby, 1]),
    before = image.data.slice()
  applyLocalTools(image, { masks: [fullMask({ Exposure: 2 }), color] })
  close(image.data[0], before[0] * 8)
  close(image.data[4], before[4] * 4)
  assert.equal(rangeWeight(color, [linear, linear, linear], 'srgb-linear'), 1)
  assert.equal(rangeWeight(color, [nearby, nearby, nearby], 'srgb-linear'), 0)
  const white = { ...color, color: '#ffffff', tolerance: 0.01 }
  assert.equal(rangeWeight(white, [4, 4, 4], 'srgb-linear'), 0)
  assert.equal(rangeWeight(white, [-1, -1, -1], 'srgb-linear'), 0)
  const luminance = { type: 'luminance-range', min: 0, max: 1, softness: 0 }
  assert.equal(rangeWeight(luminance, [2, 2, 2], 'srgb-linear'), 0)
  assert.equal(rangeWeight(luminance, [-0.2, -0.2, -0.2], 'srgb-linear'), 0)
})

test('float range selection snapshots precede depth blur and preceding mask adjustments', () => {
  const original = frame(3, [0.01, 0.01, 0.01, 1, 2, 2, 2, 1, 4, 4, 4, 1]),
    depth = { raster: raster([0]) },
    blurred = { ...original, data: original.data.slice() },
    image = { ...original, data: original.data.slice() },
    mask = validateLocalTool('mask', {
      type: 'luminance-range',
      min: 0,
      max: 0.02,
      softness: 0,
      adjustments: { Exposure: 1 }
    })
  applyLensBlur(blurred, depth, focus)
  assert.ok(blurred.data[0] > 0.02)
  applyLocalTools(image, { depth, lensBlur: focus, masks: [fullMask({ Exposure: 1 }), mask] })
  close(image.data[0], blurred.data[0] * 4)
  close(image.data[4], blurred.data[4] * 2)
  close(image.data[8], blurred.data[8] * 2)
})

test('float depth blur preserves signed HDR colors, alpha coverage and focused samples', () => {
  const color = [-0.4, 3.5, 0.20001],
    image = frame(3, [500, -700, 90, 0, ...color, 0.5, ...color, 1]),
    depth = { raster: raster([0]) }
  applyLensBlur(image, depth, focus)
  let alphas = [0, 0.5, 1]
  for (let pass = 0; pass < 3; pass++)
    alphas = alphas.map((_, x, a) => (a[Math.max(0, x - 1)] + a[x] + a[Math.min(2, x + 1)]) / 3)
  for (let x = 0; x < 3; x++) {
    for (let c = 0; c < 3; c++) close(image.data[x * 4 + c], color[c])
    close(image.data[x * 4 + 3], alphas[x])
  }
  const focused = frame(3, [-0.25, 4, 0.20001, 0.3, 1.01, -0.5, 0.02001, 0.8, 2, 3, -1, 1]),
    before = focused.data.slice()
  applyLensBlur(focused, { raster: raster([0, 128, 255]) }, focus)
  assert.deepEqual(focused.data.slice(4, 8), before.slice(4, 8))
})

test('legacy local repair, depth blur and repeated mask output remains byte exact', () => {
  const width = 4,
    height = 3,
    data = Uint8ClampedArray.from({ length: 48 }, (_, i) =>
      i % 4 === 3 ? [0, 64, 128, 255][Math.floor(i / 4) % 4] : (i * 37 + 13) % 256
    ),
    masks = [
      validateLocalTool('mask', {
        type: 'radial',
        center: { x: 0.5, y: 0.5 },
        rx: 1,
        ry: 1,
        feather: 0.6,
        opacity: 0.6,
        adjustments: { Exposure: 0.75, Contrast: 20, Saturation: -30 }
      }),
      validateLocalTool('mask', {
        type: 'luminance-range',
        min: 0.1,
        max: 0.7,
        softness: 0.1,
        adjustments: { Exposure: -0.25 }
      })
    ],
    repairs = ['clone', 'heal'].map((type) =>
      validateLocalTool('repair', {
        type,
        source: { x: 0.125, y: 0.5 },
        points: [{ x: 0.625, y: 0.5 }],
        radius: 0.4,
        feather: 0.5,
        opacity: 0.7
      })
    )
  applyLocalTools(
    { width, height, data },
    {
      masks,
      repairs,
      depth: { raster: raster([20, 220]) },
      lensBlur: validateDepthSettings({ amount: 0.15, min: 0.3, max: 0.7, softness: 0.2 })
    }
  )
  assert.deepEqual(
    Array.from(data),
    [
      191, 144, 180, 2, 186, 215, 229, 61, 62, 96, 131, 86, 164, 195, 102, 236, 166, 120, 153, 2, 231, 57, 81,
      61, 154, 187, 219, 11, 137, 168, 123, 230, 147, 102, 137, 2, 77, 110, 145, 61, 238, 253, 122, 86, 119,
      150, 141, 236
    ]
  )
})
