import test from 'node:test'
import assert from 'node:assert/strict'
import { createProfileToLinearSrgb } from '../web/icc-input.js'
import {
  convertRgbColor,
  createNamedInputTransform,
  decodeSrgb,
  makeColorProfile,
  matrixToLinearSrgb
} from '../web/color-spaces.js'
import { iccCurve, iccTags, rebuildIcc, withIccCurve } from './fixtures/icc-input.mjs'
import { runIccInputExperiment } from '../scripts/experiments/icc-input.mjs'

function convert(profile, values, target = new Float64Array(3), offset = 0) {
  const transform = createProfileToLinearSrgb(profile)
  assert.equal(transform.kind, 'matrix-trc')
  transform.convert(...values, target, offset)
  return target
}

function close(actual, expected, tolerance = 1e-8) {
  actual.forEach((value, i) =>
    assert.ok(Math.abs(value - expected[i]) <= tolerance, `${actual} != ${expected}`)
  )
}

test('named sRGB input decodes low Uint16 levels without an encoded roundtrip or alpha mutation', () => {
  const transform = createNamedInputTransform(),
    output = new Float64Array([9, 9, 9, 0.25])
  transform.convert(1 / 65535, 2 / 65535, 0.5, output)
  close(output, [decodeSrgb(1 / 65535), decodeSrgb(2 / 65535), decodeSrgb(0.5), 0.25], 1e-15)
})

test('named Display P3 input preserves its out-of-sRGB linear channels', () => {
  const output = new Float64Array(3)
  createNamedInputTransform('display-p3').convert(1, 0, 0, output)
  close(output, convertRgbColor([1, 0, 0], 'display-p3', 'srgb').map(decodeSrgb), 1e-12)
  assert.ok(output[0] > 1 && output[1] < 0 && output[2] < 0)
})

test('ICC named input stays unbounded and agrees with the existing fixed-space owner within profile rounding', () => {
  for (const space of ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020']) {
    for (const rgb of [
      [0, 0, 0],
      [1, 1, 1],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.01, 0.4, 0.93]
    ]) {
      close(
        convert(makeColorProfile(space), rgb),
        convertRgbColor(rgb, space, 'srgb').map(decodeSrgb),
        1.2e-4
      )
    }
  }
  const red = convert(makeColorProfile('display-p3'), [1, 0, 0])
  assert.ok(red[0] > 1.2)
  assert.ok(red[1] < -0.04)
  assert.ok(red[2] < -0.01)
})

test('v2/v4 identity, canonical gamma and continuous tables preserve real low source bits', () => {
  const targetMatrix = matrixToLinearSrgb([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    xyz = iccTags(makeColorProfile()),
    column = [8, 12, 16].map((at) => new DataView(xyz.rXYZ.buffer).getInt32(at) / 65536),
    expectedRed = (x) =>
      [0, 1, 2]
        .map(
          (row) =>
            targetMatrix[row * 3] * column[0] +
            targetMatrix[row * 3 + 1] * column[1] +
            targetMatrix[row * 3 + 2] * column[2]
        )
        .map((value) => value * x)
  for (const major of [2, 4]) {
    const identity = withIccCurve(iccCurve('curv'), { major }),
      gamma = withIccCurve(iccCurve('curv', [563]), { major }),
      table = withIccCurve(iccCurve('curv', [0, 1000, 14000, 40000, 65535]), { major })
    close(convert(identity, [1 / 65535, 0, 0]), expectedRed(1 / 65535))
    close(convert(gamma, [0.2, 0, 0]), expectedRed(0.2 ** (563 / 256)))
    close(convert(table, [0.375, 0, 0]), expectedRed(7500 / 65535))
    const one = convert(table, [1 / 65535, 0, 0]),
      two = convert(table, [2 / 65535, 0, 0])
    assert.ok(one[0] > 0 && two[0] > one[0])
    close(
      two,
      Array.from(one, (value) => value * 2)
    )
  }
})

test('all five v4 parametric types use the specification branch and parameter order', () => {
  const cases = [
    [0, [2], (x) => x ** 2, []],
    [1, [2, 1, -0.25], (x) => (x < 0.25 ? 0 : (x - 0.25) ** 2), [0.25]],
    [2, [2, 1, -0.25, 0.125], (x) => (x < 0.25 ? 0.125 : (x - 0.25) ** 2 + 0.125), [0.25]],
    [3, [2, 1, 0, 0.25, 0.25], (x) => (x < 0.25 ? 0.25 * x : x ** 2), [0.25]],
    [4, [2, 1, 0, 0.25, 0.25, 0.125, 0.0625], (x) => (x < 0.25 ? 0.25 * x + 0.0625 : x ** 2 + 0.125), [0.25]]
  ]
  const identity = createProfileToLinearSrgb(withIccCurve(iccCurve('curv')))
  for (const [type, parameters, evaluate, boundaries] of cases) {
    const profile = withIccCurve(iccCurve(type, parameters))
    for (const x of [0, 0.1, 0.5, 1, ...boundaries.flatMap((d) => [d - 1e-9, d, d + 1e-9])]) {
      const expected = new Float64Array(3),
        value = evaluate(x)
      // Identity source with the same matrix isolates the forward curve, including
      // deliberately discontinuous type-4 branch values and nonzero black offset.
      identity.convert(1, 1, 1, expected)
      expected.forEach((component, i) => {
        expected[i] = component * value
      })
      close(convert(profile, [x, x, x]), expected)
    }
  }
})

test('profile ownership, independent per-channel curves, chad role and alpha storage are explicit', () => {
  const profile = rebuildIcc({
      rTRC: iccCurve('curv'),
      gTRC: iccCurve('curv', [512]),
      bTRC: iccCurve('curv', [768])
    }),
    original = profile.slice(),
    transform = createProfileToLinearSrgb(profile),
    out = new Float32Array([9, 9, 9, 0.1234567, 9, 9, 9, 0.7654321]),
    alpha = [out[3], out[7]]
  transform.convert(0.2, 0.3, 0.4, out, 0)
  transform.convert(0.2, 0.3, 0.4, out, 4)
  assert.deepEqual([out[3], out[7]], alpha)
  close(out.subarray(0, 3), convert(withIccCurve(iccCurve('curv')), [0.2, 0.09, 0.064]), 1e-8)
  assert.deepEqual(profile, original)
  profile.fill(0)
  const again = new Float32Array(3)
  transform.convert(0.2, 0.3, 0.4, again)
  assert.deepEqual(again, out.subarray(0, 3))
  const p3 = makeColorProfile('display-p3'),
    without = rebuildIcc({ chad: null }, { source: p3 })
  close(convert(p3, [1, 0, 0]), convert(without, [1, 0, 0]))
})

test('valid unsupported containers return reasons; malformed input and invalid output fail visibly', () => {
  const profile = makeColorProfile(),
    lab = profile.slice(),
    printer = profile.slice(),
    unknown = new Uint8Array(8)
  lab.set(new TextEncoder().encode('Lab '), 20)
  printer.set(new TextEncoder().encode('prtr'), 12)
  unknown.set(new TextEncoder().encode('mAB '))
  assert.equal(createProfileToLinearSrgb(lab).reason, 'profile-pcs')
  assert.equal(createProfileToLinearSrgb(printer).reason, 'profile-class')
  for (const id of ['A2B0', 'A2B1', 'A2B2', 'D2B0', 'D2B1', 'D2B2', 'D2B3'])
    assert.equal(createProfileToLinearSrgb(rebuildIcc({ [id]: unknown })).reason, 'profile-lut')
  assert.equal(createProfileToLinearSrgb(rebuildIcc({ rTRC: null })).reason, 'profile-matrix-trc-missing')
  assert.equal(createProfileToLinearSrgb(rebuildIcc({}, { major: 2 })).reason, 'profile-v2-parametric')
  assert.equal(createProfileToLinearSrgb(rebuildIcc({ cicp: unknown })).reason, 'profile-interpretation')
  const singular = iccTags(profile)
  assert.throws(() => createProfileToLinearSrgb(rebuildIcc({ rXYZ: singular.gXYZ })), /singular/)
  assert.throws(() => createProfileToLinearSrgb(new Uint8Array(10)), /Invalid RGB ICC/)
  const transform = createProfileToLinearSrgb(profile)
  for (const value of [-0.1, 1.1, NaN, Infinity])
    assert.throws(() => transform.convert(value, 0, 0, new Float32Array(3)), /normalized/)
  assert.throws(() => transform.convert(0, 0, 0, new Uint16Array(3)), /float-capable/)
  assert.throws(() => transform.convert(0, 0, 0, new Float32Array(3), 1), /float-capable/)
  // Large legal-looking coefficients can be finite in JS but not in a frame.
  const oversized = createProfileToLinearSrgb(withIccCurve(iccCurve(1, [100, 10, 0])))
  assert.throws(() => oversized.convert(1, 1, 1, new Float32Array(3)), /finite Float32/)
})

test('independent native LCMS validates Float32 input interpretation without byte intermediates', (t) => {
  const result = runIccInputExperiment()
  if (
    (result.status === 77 || result.error?.code === 'ENOENT') &&
    process.env.OPENLR_TEST_CMS !== '1' &&
    !process.env.OPENLR_LCMS_LIBRARY &&
    !process.env.OPENLR_CMS_PYTHON
  )
    return t.skip(
      'Native LCMS/Python unavailable; set OPENLR_LCMS_LIBRARY and OPENLR_CMS_PYTHON, OPENLR_TEST_CMS=1 requires this check'
    )
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error))
  const measured = JSON.parse(result.stdout)
  assert.equal(measured.samples, 10557)
  assert.equal(Object.keys(measured.metrics).length, 16)
  t.diagnostic(result.stdout.trim())
})
