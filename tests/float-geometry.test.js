import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync } from '../web/vendor/fflate/browser.js'
import { decodeSrgb, encodeSrgb } from '../web/color-spaces.js'
import { transformFrame, resizeFrame } from '../web/frame-geometry.js'
import { warpOpticsFrame, warpOptics, compileOptics } from '../web/optics.js'
import { filledFrame } from '../web/fill.js'
import { correctEyesFrame } from '../web/culling.js'

const frame = (width, height, data) => ({
  width,
  height,
  colorSpace: 'srgb-linear',
  data: Float32Array.from(data)
})
const near = (actual, expected, tolerance = 2e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)
const patch = (rgba, extra = {}) => ({
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  width: 1,
  height: 1,
  rgba: Buffer.from(deflateSync(Uint8Array.from(rgba))).toString('base64'),
  ...extra
})

test('integer crop, quarter turns and reflection copy float samples exactly', () => {
  const source = frame(
    3,
    2,
    Array.from({ length: 24 }, (_, i) => (i % 4 === 3 ? 0 : i / 10000 - 0.001))
  )
  assert.equal(transformFrame(source), source)
  const expected = {
    '0,false': [1, 2, 4, 5],
    '0,true': [2, 1, 5, 4],
    '1,false': [4, 1, 5, 2],
    '1,true': [5, 2, 4, 1],
    '2,false': [5, 4, 2, 1],
    '2,true': [4, 5, 1, 2],
    '3,false': [2, 5, 1, 4],
    '3,true': [1, 4, 2, 5]
  }
  for (let turn = 0; turn < 4; turn++)
    for (const flip of [false, true]) {
      const output = transformFrame(source, { crop: { x: 1 / 3, y: 0, w: 2 / 3, h: 1 }, turn, flip })
      assert.deepEqual(
        [...output.data],
        expected[`${turn},${flip}`].flatMap((i) => [...source.data.slice(i * 4, i * 4 + 4)])
      )
    }
})

test('resizing retains sub-byte distinctions, signed gamut and highlights with alpha-aware interpolation', () => {
  const source = frame(2, 1, [-0.2, 2.0001, 0.10001, 0.25, 100, -40, 70, 0]),
    output = resizeFrame(source, 1, 1)
  near(output.data[0], source.data[0])
  near(output.data[1], source.data[1])
  near(output.data[2], source.data[2])
  near(output.data[3], 0.125)
  const close = frame(2, 1, [0.10001, 0, 0, 1, 0.10002, 0, 0, 1]),
    enlarged = resizeFrame(close, 3, 1)
  assert.equal(enlarged.data[0], close.data[0])
  assert.equal(enlarged.data[8], close.data[4])
  near(enlarged.data[4], (close.data[0] + close.data[4]) / 2, 1e-8)
  assert.ok(enlarged.data[0] !== enlarged.data[4] && enlarged.data[4] !== enlarged.data[8])
  assert.throws(() => resizeFrame(close, 0, 1), /positive/)
})

test('optics reuses the common map and retains linear values and partial transparent borders', () => {
  const source = frame(
    2,
    2,
    [-0.1, 2, 0.10001, 1, 0.3, 4, 0.10002, 0.5, -0.3, 5, 0.20001, 1, 0.6, 7, 0.20002, 0.5]
  )
  assert.equal(warpOpticsFrame(source, {}), source)
  const output = warpOpticsFrame(source, { shiftX: 25 })
  near(output.data[0], -0.1)
  near(output.data[1], 2)
  near(output.data[3], 0.5)
  near(output.data[4], (-0.1 + 0.3 * 0.5) / 1.5)
  near(output.data[5], (2 + 4 * 0.5) / 1.5)
  near(output.data[7], 0.75)
  assert.deepEqual(
    [...source.data],
    [-0.1, 2, 0.10001, 1, 0.3, 4, 0.10002, 0.5, -0.3, 5, 0.20001, 1, 0.6, 7, 0.20002, 0.5].map(Math.fround)
  )
})

test('TCA keeps conservative channel alpha at independently mapped sample locations', () => {
  const source = frame(
      3,
      3,
      Array.from({ length: 36 }, (_, i) =>
        i % 4 === 3 ? 1 : i % 4 === 0 ? -0.2 : i % 4 === 1 ? 3 : 0.123456
      )
    ),
    recipe = { redScale: 100, blueScale: -100, shiftX: 5 },
    mapping = compileOptics(source, recipe),
    output = warpOpticsFrame(source, recipe)
  const alphas = [0, 1, 2].map((channel) => {
    const p = mapping.toOriginal({ x: 1 / 6, y: 1 / 6 }, channel),
      x = p.x * 3 - 0.5,
      y = p.y * 3 - 0.5
    return (x < 0 ? 1 + x : 1) * (y < 0 ? 1 + y : 1)
  })
  near(output.data[3], Math.min(...alphas))
  near(output.data[0], -0.2)
  near(output.data[1], 3)
  near(output.data[2], 0.123456)
})

test('legacy baked fill decodes only patch samples and composites onto unclipped float base', () => {
  const source = frame(3, 1, [-0.2, 4, 0.10001, 1, -0.1, 2, 0.40001, 0.25, 1.5, -0.4, 0.20002, 1]),
    fill = patch([128, 200, 10, 128], { x: 1 / 3, w: 1 / 3 }),
    output = filledFrame(source, [fill]),
    alpha = 128 / 255,
    remaining = 0.25 * (1 - alpha),
    total = alpha + remaining
  assert.deepEqual(output.data.slice(0, 4), source.data.slice(0, 4))
  assert.deepEqual(output.data.slice(8), source.data.slice(8))
  for (let channel = 0; channel < 3; channel++)
    near(
      output.data[4 + channel],
      (decodeSrgb([128, 200, 10][channel] / 255) * alpha + source.data[4 + channel] * remaining) / total
    )
  near(output.data[7], total)
  assert.deepEqual(filledFrame(source, [patch([200, 100, 50, 0])]).data, source.data)
  const stretched = filledFrame(source, [patch([128, 200, 10, 255])])
  for (let i = 0; i < stretched.data.length; i += 4) {
    near(stretched.data[i], decodeSrgb(128 / 255))
    assert.equal(stretched.data[i + 3], 1)
  }
  assert.equal(filledFrame(source, []), source)
  assert.throws(() => filledFrame(source, [{ ...fill, width: 2 }]), /Incomplete/)
})

test('float red-eye changes only selected red samples using the continuous existing rule', () => {
  const source = frame(3, 1, [-0.2, 2, 0.10001, 0.2, 4, 0.1, -0.02, 0.5, 5, -0.4, 0.20002, 1]),
    eye = { x: 0.5, y: 0.5, rx: 1 / 6, ry: 0.5 },
    output = correctEyesFrame(source, [eye])
  near(output.data[4], decodeSrgb((encodeSrgb(source.data[5]) + encodeSrgb(source.data[6])) / 2))
  for (let i = 0; i < source.data.length; i++) if (i !== 4) assert.equal(output.data[i], source.data[i])
  assert.equal(correctEyesFrame(source, []), source)
  assert.deepEqual(correctEyesFrame(source, [{ ...eye, x: -1 }]).data, source.data)
})

test('legacy optics byte output keeps its baseline snapshot', () => {
  const source = {
      width: 7,
      height: 5,
      data: Uint8ClampedArray.from({ length: 140 }, (_, i) => (i * 37 + 11) % 256)
    },
    output = warpOptics(source, { rotate: 11, redScale: 55, blueScale: -35, vertical: 6 })
  assert.equal(
    createHash('sha256').update(output.data).digest('hex'),
    '1a0c81d49e1d58b9eb75343958bf09b7d0d2b73b025bb25f76ad569821d97285'
  )
})
