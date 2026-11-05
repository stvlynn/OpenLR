import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateCurvePoints,
  validateToneCurves,
  validateToneCurveRecipe,
  curvePoints,
  setToneCurve,
  hasToneCurveEffect,
  compileCurve,
  createPointCurves,
  createPointCurveTables
} from '../web/tone-curves.js'
import { encodeSrgb, decodeSrgb } from '../web/color-spaces.js'
import { renderFrame } from '../web/render.js'

const identity = [
  { x: 0, y: 0 },
  { x: 1, y: 1 }
]
const close = (actual, expected, tolerance = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`)

test('curve validation and updates preserve independent channels and neutral editable knots', () => {
  for (const invalid of [
    null,
    {},
    [],
    [identity[0]],
    [{ x: 0, y: 0 }, , { x: 1, y: 1 }],
    [
      { x: 0.1, y: 0 },
      { x: 1, y: 1 }
    ],
    [
      { x: 0, y: 0 },
      { x: 0.5, y: 1 },
      { x: 0.5, y: 0 },
      { x: 1, y: 1 }
    ],
    [
      { x: 0, y: 0 },
      { x: 0.6, y: 0 },
      { x: 0.5, y: 1 },
      { x: 1, y: 1 }
    ],
    [
      { x: 0, y: -0.01 },
      { x: 1, y: 1 }
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: Infinity }
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: NaN }
    ],
    [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1 }
    ]
  ])
    assert.throws(() => validateCurvePoints(invalid), /Curve points/)
  for (const invalid of [null, [], { yellow: identity }, { red: null }])
    assert.throws(() => validateToneCurves(invalid))
  assert.throws(() => curvePoints({}, 'yellow'), /channel/)
  assert.throws(() => validateToneCurveRecipe({ toneCurves: { red: [] } }))
  assert.equal(hasToneCurveEffect(undefined), false)
  const input = {
    Exposure: 1,
    toneCurves: {
      blue: [
        { x: 0, y: 0.1 },
        { x: 1, y: 1 }
      ]
    }
  }
  const original = structuredClone(input)
  const neutral = [
    { x: 0, y: 0 },
    { x: 0.4, y: 0.4 },
    { x: 1, y: 1 }
  ]
  const edit = setToneCurve(input, 'red', neutral)
  assert.deepEqual(edit.toneCurves.red, neutral)
  assert.equal(hasToneCurveEffect({ red: neutral }), false)
  assert.equal(createPointCurves({ toneCurves: { red: neutral } }), null)
  assert.equal(createPointCurveTables({ toneCurves: { red: neutral } }), null)
  neutral[1].y = 0.8
  edit.toneCurves.blue[0].y = 0.3
  assert.deepEqual(input, original)
  assert.equal(edit.toneCurves.red[1].y, 0.4)
  const reset = setToneCurve(edit, 'red', identity)
  assert.equal(reset.toneCurves.red, undefined)
  assert.equal(reset.toneCurves.blue[0].y, 0.3)
  assert.deepEqual(setToneCurve(setToneCurve({}, 'red', neutral), 'red', identity), {})
  const defaults = curvePoints({}, 'green')
  defaults[0].y = 0.2
  assert.deepEqual(curvePoints({}, 'green'), identity)
})

test('PCHIP preserves knots, extrema and local shape including close floating inputs', () => {
  const reference = compileCurve([
    { x: 0, y: 0 },
    { x: 0.5, y: 0.75 },
    { x: 1, y: 1 }
  ])
  close(reference(0.25), 0.453125)
  close(reference(0.75), 0.921875)
  const fixtures = [
    [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.8 },
      { x: 0.5, y: 0.1 },
      { x: 0.75, y: 0.9 },
      { x: 1, y: 1 }
    ],
    [
      { x: 0, y: 0.2 },
      { x: 0.25, y: 0.2 },
      { x: 0.5, y: 0.8 },
      { x: 1, y: 0.8 }
    ],
    [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.1 },
      { x: 0.5000000000000001, y: 0.9 },
      { x: 1, y: 1 }
    ],
    [
      { x: 0, y: 0.1 },
      { x: Number.MIN_VALUE, y: 0.2 },
      { x: 1, y: 0.8 }
    ]
  ]
  for (const points of fixtures) {
    const evaluate = compileCurve(points)
    for (const point of points) close(evaluate(point.x), point.y)
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i],
        b = points[i + 1]
      for (let step = 0; step <= 1000; step++) {
        const y = evaluate(a.x + (b.x - a.x) * (step / 1000))
        assert.ok(Number.isFinite(y))
        assert.ok(y >= Math.min(a.y, b.y) - 1e-15 && y <= Math.max(a.y, b.y) + 1e-15)
      }
    }
  }
  const neutral = compileCurve([
    { x: 0, y: 0 },
    { x: 0.35, y: 0.35 },
    { x: 1, y: 1 }
  ])
  for (const x of [-3, -0.01, 0, 0.1, 0.35, 0.75, 1, 4]) assert.equal(neutral(x), x)
})

test('point curves compose master before channel without quantizing signed or HDR samples', () => {
  const edit = {
    toneCurves: {
      rgb: [
        { x: 0, y: 0.5 },
        { x: 1, y: 1 }
      ],
      red: [
        { x: 0, y: 0 },
        { x: 1, y: 0.5 }
      ]
    }
  }
  const apply = createPointCurves(edit)
  const input = decodeSrgb(0.4)
  close(apply(input, 0), decodeSrgb(0.35))
  close(apply(input, 1), decodeSrgb(0.7))
  assert.notEqual(apply(input, 0), decodeSrgb(0.6), 'Channel-first is a different transform')
  const redOnly = createPointCurves({
    toneCurves: {
      red: [
        { x: 0, y: 0.15 },
        { x: 1, y: 0.8 }
      ]
    }
  })
  close(encodeSrgb(redOnly(decodeSrgb(-0.5), 0)), -0.35)
  close(encodeSrgb(redOnly(decodeSrgb(2), 0)), 1.8)
  assert.equal(redOnly(input, 1), input)
  const fixedEnds = createPointCurves({
    toneCurves: {
      rgb: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.8 },
        { x: 1, y: 1 }
      ]
    }
  })
  assert.equal(fixedEnds(-0.2, 0), -0.2)
  assert.equal(fixedEnds(4, 0), 4)
  const low = redOnly(0.000001, 0),
    high = redOnly(0.000002, 0)
  assert.notEqual(low, high)
  const tables = createPointCurveTables(edit)
  assert.equal(tables[0][102], 89)
  assert.equal(tables[1][102], 178)
})

test('shared floating renderer changes the selected curve channel and preserves source, alpha and existing curve order', () => {
  const source = {
    width: 2,
    height: 1,
    colorSpace: 'srgb-linear',
    data: new Float32Array([decodeSrgb(0.4), decodeSrgb(0.4), decodeSrgb(0.4), 1, -0.2, 2, 4, 0.5])
  }
  const bytes = source.data.slice()
  const edit = {
    'Curve shadows': 20,
    toneCurves: {
      red: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.75 },
        { x: 1, y: 1 }
      ]
    }
  }
  const old = renderFrame(source, { 'Curve shadows': 20 })
  const actual = renderFrame(source, edit)
  close(actual.data[0], createPointCurves(edit)(old.data[0], 0), 1e-7)
  assert.equal(actual.data[1], old.data[1])
  assert.equal(actual.data[2], old.data[2])
  assert.equal(actual.data[3], old.data[3])
  assert.deepEqual(actual.data.slice(4), old.data.slice(4))
  assert.deepEqual(source.data, bytes)
  assert.deepEqual(renderFrame(source, { 'Curve shadows': 20, toneCurves: { red: identity } }).data, old.data)
})
