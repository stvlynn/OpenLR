import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GRADING_WHEELS,
  validateColorGrading,
  validateColorGradingRecipe,
  colorGradingValue,
  setColorGrading,
  hasColorGradingEffect,
  hueColor,
  gradingWeights,
  createColorGrading
} from '../web/color-grading.js'
import { renderFrame } from '../web/render.js'

const close = (actual, expected, tolerance = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`)
const yOf = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]

test('grading validation canonicalizes complete independent wheels and keeps dormant choices neutral', () => {
  const defaults = colorGradingValue({})
  assert.deepEqual(defaults, {
    shadows: { hue: 0, saturation: 0, luminance: 0 },
    midtones: { hue: 0, saturation: 0, luminance: 0 },
    highlights: { hue: 0, saturation: 0, luminance: 0 },
    global: { hue: 0, saturation: 0, luminance: 0 },
    balance: 0,
    blending: 50
  })
  assert.equal(validateColorGrading({ global: { hue: 360 } }).global.hue, 0)
  for (const value of [
    null,
    [],
    2,
    { unexpected: 1 },
    { shadows: null },
    { global: [] },
    { global: { unknown: 0 } },
    { global: { hue: 361 } },
    { midtones: { hue: -1 } },
    { highlights: { saturation: 101 } },
    { global: { saturation: '20' } },
    { global: { luminance: -101 } },
    { balance: Infinity },
    { blending: NaN },
    { blending: -1 }
  ])
    assert.throws(() => validateColorGrading(value), /grading/)
  assert.throws(() => validateColorGradingRecipe({ colorGrading: { balance: 101 } }), /grading/)
  const dormant = { shadows: { hue: 80 }, balance: 100, blending: 0 }
  const edit = setColorGrading({ Exposure: 1 }, dormant)
  assert.equal(hasColorGradingEffect(edit.colorGrading), false)
  assert.equal(hasColorGradingEffect(undefined), false)
  assert.equal(createColorGrading(edit), null)
  assert.equal(edit.colorGrading.shadows.hue, 80)
  assert.deepEqual(setColorGrading(edit, {}), { Exposure: 1 })
  dormant.shadows.hue = 10
  assert.equal(edit.colorGrading.shadows.hue, 80)
  const copy = colorGradingValue(edit)
  copy.shadows.hue = 120
  assert.equal(edit.colorGrading.shadows.hue, 80)
  assert.equal(hasColorGradingEffect({ global: { luminance: 0.001 } }), true)
  for (const [hue, color] of [
    [0, [1, 0, 0]],
    [60, [1, 1, 0]],
    [120, [0, 1, 0]],
    [180, [0, 1, 1]],
    [240, [0, 0, 1]],
    [300, [1, 0, 1]],
    [360, [1, 0, 0]]
  ])
    assert.deepEqual(hueColor(hue), color)
})

test('grading tonal weights are normalized and continuous with distinct balance and blending effects', () => {
  for (const balance of [-100, 0, 100])
    for (const blending of [0, 50, 100]) {
      let prior = gradingWeights(0, balance, blending)
      for (let step = 1; step <= 10000; step++) {
        const w = gradingWeights(step / 2500, balance, blending)
        close(
          w.reduce((sum, value) => sum + value, 0),
          1
        )
        assert.ok(w.every((value) => value >= 0 && value <= 1))
        assert.ok(w.every((value, i) => Math.abs(value - prior[i]) < 0.02))
        prior = w
      }
    }
  assert.deepEqual(gradingWeights(-1), [1, 0, 0])
  const centered = gradingWeights(0.18)
  close(centered[0], centered[2])
  assert.ok(centered[1] > 0.73 && centered[1] < 0.74)
  assert.ok(gradingWeights(0.18, -100)[0] > 0.84)
  assert.ok(gradingWeights(0.18, 100)[2] > 0.84)
  assert.ok(gradingWeights(0.18, 0, 100)[0] > gradingWeights(0.18, 0, 0)[0])
})

test('shared grading conserves chroma-only luminance and applies intentional gain without clipping signed or HDR samples', () => {
  const grading = {
    shadows: { hue: 220, saturation: 70 },
    midtones: { hue: 30, saturation: 40 },
    highlights: { hue: 50, saturation: 55 },
    global: { hue: 300, saturation: 20 }
  }
  const apply = createColorGrading({ colorGrading: grading })
  const fixtures = [
    [0, 0, 0, 0.3],
    [-0.2, 0.5, 0.7, 0.4],
    [2, 0.1, 0.3, 1],
    [-2, -1, -0.5, 0],
    [1e30, 1e29, -1e30, 0.8],
    [1e-30, 0, 2e-30, 1]
  ]
  for (let i = 0; i <= 1000; i++) fixtures.push([i / 250, i / 250, i / 250, i / 1000])
  for (const input of fixtures) {
    const result = [...input]
    assert.equal(apply(result), result)
    close(yOf(result), yOf(input), Math.max(1e-40, Math.max(...input.slice(0, 3).map(Math.abs)) * 2e-15))
    assert.equal(result[3], input[3])
    assert.ok(result.every(Number.isFinite))
  }
  const black = [0, 0, 0, 0.4]
  apply(black)
  assert.deepEqual(black, [0, 0, 0, 0.4])
  const red = [0.2, 0.2, 0.2, 1]
  createColorGrading({ colorGrading: { global: { hue: 0, saturation: 100 } } })(red)
  close(red[0], 0.25)
  close(red[1], 0.2 - (0.05 * 0.2126) / 0.7874)
  close(yOf(red), 0.2)
  const gain = createColorGrading({ colorGrading: { global: { luminance: 50 } } })
  const input = [-0.2, 2, 4, 0.7]
  gain(input)
  assert.deepEqual(input, [-0.4, 4, 8, 0.7])
  for (const luminance of [-100, 100]) {
    const value = Object.fromEntries(
      GRADING_WHEELS.map((name) => [name, { hue: 210, saturation: 100, luminance }])
    )
    value.balance = 100
    value.blending = 0
    const extreme = [1e30, -1e30, 2e30, 0.4]
    createColorGrading({ colorGrading: value })(extreme)
    assert.ok(extreme.every(Number.isFinite))
    assert.equal(extreme[3], 0.4)
  }
})

test('floating renderer grades after curves and mixer, preserves alpha/source and leaves neutral old recipes exact', () => {
  const source = {
    width: 2,
    height: 1,
    colorSpace: 'srgb-linear',
    data: new Float32Array([0.18, 0.25, 0.4, 1, -0.2, 2, 4, 0.5])
  }
  const original = source.data.slice()
  const recipe = { Exposure: 0.25, 'Curve shadows': 12, Saturation: 10, 'Blue Hue': 10 }
  const before = renderFrame(source, recipe)
  const colorGrading = {
    shadows: { hue: 230, saturation: 55 },
    global: { hue: 50, saturation: 20, luminance: 30 }
  }
  const actual = renderFrame(source, { ...recipe, colorGrading })
  const expected = before.data.slice()
  const grade = createColorGrading({ colorGrading })
  for (let offset = 0; offset < expected.length; offset += 4) grade(expected, offset)
  assert.deepEqual(actual.data, expected)
  assert.deepEqual(source.data, original)
  assert.equal(actual.data[3], original[3])
  assert.equal(actual.data[7], original[7])
  assert.deepEqual(
    renderFrame(source, { ...recipe, colorGrading: { global: { hue: 80 }, blending: 100 } }).data,
    before.data
  )
})
