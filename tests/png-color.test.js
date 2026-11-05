import test from 'node:test'
import assert from 'node:assert/strict'
import { convertPngPixels } from '../web/png-color.js'
import {
  convertRgbColor,
  createChromaticInputTransform,
  decodeSrgb,
  makeColorProfile
} from '../web/color-spaces.js'
import { createGrayProfileToLinearSrgb, createProfileToLinearSrgb } from '../web/icc-input.js'
import { iccCurve, makeGrayProfile, rebuildIcc } from './fixtures/icc-input.mjs'
import { inputPrecisionDescription } from '../web/input-color.js'
import { runPngColorExperiment } from '../scripts/experiments/png-input-color.mjs'

const P3 = { white: [0.3127, 0.329], red: [0.68, 0.32], green: [0.265, 0.69], blue: [0.15, 0.06] }
const close = (a, b, tolerance = 1e-7) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tolerance, `${a} != ${b}`))
function pixels(metadata = {}, rgb = [0.2, 0.4, 0.6], extra = {}) {
  return {
    width: 1,
    height: 1,
    data: Float32Array.from([...rgb, 12345 / 65535]),
    sourceBits: 16,
    colorType: 6,
    metadata,
    ...extra
  }
}

test('PNG chooses cICP then ICC then sRGB then independent gamma/chromaticities', () => {
  const rgb = [0.2, 0.4, 0.6],
    cicp = { colorPrimaries: 12, transferCharacteristics: 13, matrixCoefficients: 0, fullRange: 1 },
    common = { icc: makeColorProfile('srgb'), srgb: 0, gamma: 1, chromaticities: P3 },
    top = convertPngPixels(pixels({ ...common, cicp })).frame
  close(top.data.subarray(0, 3), convertRgbColor(rgb.map(Math.fround), 'display-p3', 'srgb').map(decodeSrgb))
  assert.equal(top.provenance.pngColorSource, 'cicp')
  const icc = convertPngPixels(pixels(common)).frame
  close(icc.data.subarray(0, 3), rgb.map(Math.fround).map(decodeSrgb), 2e-5)
  assert.equal(icc.provenance.pngColorSource, 'iccp')
  const srgb = convertPngPixels(pixels({ srgb: 0, gamma: 1, chromaticities: P3 })).frame
  close(srgb.data.subarray(0, 3), rgb.map(Math.fround).map(decodeSrgb), 1e-8)
  assert.equal(srgb.provenance.pngColorSource, 'srgb')
  const low = convertPngPixels(pixels({ gamma: 1, chromaticities: P3 }, [1, 0, 0])).frame
  close(low.data.subarray(0, 3), convertRgbColor([1, 0, 0], 'display-p3', 'srgb').map(decodeSrgb))
  assert.ok(low.data[0] > 1 && low.data[1] < 0 && low.data[2] < 0)
})

test('PNG gamma is the encoding exponent and 45455 is not the exact piecewise sRGB curve', () => {
  for (const gamma of [1, 0.5, 0.45455, 0.55556, 2]) {
    const input = pixels({ gamma }),
      before = input.data.slice(),
      frame = convertPngPixels(input).frame
    close(
      frame.data.subarray(0, 3),
      Array.from(before.subarray(0, 3), (v) => Math.fround(v ** (1 / gamma))),
      1e-15
    )
    assert.equal(frame.data[3], before[3])
    assert.equal(frame.provenance.pngColorSource, 'gamma')
    assert.deepEqual(frame.provenance.colorAssumptions, ['srgb-primaries'])
  }
  const encoded = Math.fround(0.02),
    gamma = convertPngPixels(pixels({ gamma: 0.45455 }, [encoded, encoded, encoded])).frame
  assert.ok(Math.abs(gamma.data[0] - decodeSrgb(encoded)) > 1e-3)
})

test('PNG chromaticities share existing white adaptation and incomplete characterization is explicit', () => {
  const white = convertPngPixels(
    pixels({ gamma: 0.5, chromaticities: { ...P3, white: [0.34567, 0.3585] } }, [1, 1, 1])
  ).frame
  close(white.data.subarray(0, 3), [1, 1, 1])
  const chrm = convertPngPixels(pixels({ chromaticities: P3 })).frame
  assert.equal(chrm.provenance.pngColorSource, 'chrm')
  assert.deepEqual(chrm.provenance.colorAssumptions, ['srgb-transfer'])
  const absent = convertPngPixels(pixels()).frame
  assert.equal(absent.provenance.pngColorSource, 'assumed-srgb')
  assert.deepEqual(absent.provenance.colorAssumptions, ['srgb'])
  const zero = convertPngPixels(pixels({ gamma: 0 })).frame
  assert.deepEqual(zero.provenance.colorWarnings, ['png-zero-gamma'])
  for (const chromaticities of [
    { ...P3, white: [0.3, 0] },
    { ...P3, blue: [1, 1] },
    { ...P3, red: P3.green }
  ])
    assert.throws(() => createChromaticInputTransform({ chromaticities }), /chromaticit/)
})

test('PNG highest unsupported characterization remains compatibility with source provenance', () => {
  for (const cicp of [
    { colorPrimaries: 9, transferCharacteristics: 16, matrixCoefficients: 0, fullRange: 1 },
    { colorPrimaries: 1, transferCharacteristics: 13, matrixCoefficients: 0, fullRange: 0 },
    { colorPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 0, fullRange: 1 }
  ]) {
    const input = pixels({ cicp, icc: makeColorProfile(), srgb: 0 }),
      original = input.data.slice(),
      result = convertPngPixels(input)
    assert.equal(result.reason, 'png-cicp')
    assert.equal(result.provenance.pngColorSource, 'cicp')
    assert.deepEqual(input.data, original)
  }
  const lut = new Uint8Array(8)
  lut.set(new TextEncoder().encode('mAB '))
  assert.equal(convertPngPixels(pixels({ icc: rebuildIcc({ A2B0: lut }), srgb: 0 })).reason, 'profile-lut')
  assert.throws(() => convertPngPixels(pixels({ icc: new Uint8Array(4) })), /ICC/)
  assert.throws(() => convertPngPixels(pixels({ srgb: 4 })), /rendering intent/)
  assert.throws(() => convertPngPixels(pixels({ gamma: -1 })), /gamma/)
  const full = { colorPrimaries: 1, transferCharacteristics: 13, matrixCoefficients: 0, fullRange: 1 }
  assert.throws(() => convertPngPixels(pixels({ cicp: { ...full, matrixCoefficients: 1 } })), /cICP/)
})

test('GRAY ICC forward curves retain source bits, alpha and neutral PCS output without weakening RGB validation', () => {
  for (const [payload, major, expected] of [
    [iccCurve('curv'), 2, (x) => x],
    [iccCurve('curv', [563]), 2, (x) => x ** (563 / 256)],
    [iccCurve('curv', [0, 32768, 65535]), 4, (x) => (x * 2 * 32768) / 65535],
    [iccCurve(0, [2]), 4, (x) => x ** 2],
    [iccCurve(3, [2, 1, 0, 0.25, 0.25]), 4, (x) => (x < 0.25 ? x / 4 : x ** 2)]
  ]) {
    const profile = makeGrayProfile(payload, { major }),
      value = Math.fround(1 / 65535),
      input = pixels({ icc: profile }, [value, value, value], { colorType: 4 }),
      alpha = input.data[3],
      frame = convertPngPixels(input).frame
    close(frame.data.subarray(0, 3), Array(3).fill(expected(value)), 1e-11)
    assert.equal(frame.data[3], alpha)
    assert.equal(frame.provenance.colorTransform, 'icc-gray-trc')
    assert.throws(() => createProfileToLinearSrgb(profile), /unsupported device color space/)
    assert.throws(() => convertPngPixels(pixels({ icc: profile })), /color type/)
  }
  assert.throws(
    () => convertPngPixels(pixels({ icc: makeColorProfile() }, [0.5, 0.5, 0.5], { colorType: 0 })),
    /color type/
  )
  const profile = makeGrayProfile(),
    lab = profile.slice()
  lab.set(new TextEncoder().encode('Lab '), 20)
  assert.equal(createGrayProfileToLinearSrgb(lab).reason, 'profile-pcs')
  assert.equal(
    createGrayProfileToLinearSrgb(makeGrayProfile(iccCurve(0, [2]), { major: 2 })).reason,
    'profile-v2-parametric'
  )
  const malformed = profile.slice()
  malformed[36] = 0
  assert.throws(() => createGrayProfileToLinearSrgb(malformed), /Invalid GRAY ICC profile/)
})

test('PNG provenance exposes significant bits and first frame while damaged palette recovery is visible', () => {
  const frame = convertPngPixels(
    pixels({
      significantBits: [12, 12, 12, 8],
      animated: true,
      decodedFrame: 'animation-first',
      invalidPaletteIndices: 1,
      colorWarnings: ['png-palette-index']
    })
  ).frame
  assert.deepEqual(frame.provenance.significantBits, [12, 12, 12, 8])
  assert.equal(frame.provenance.decodedFrame, 'animation-first')
  assert.equal(frame.provenance.invalidPaletteIndices, 1)
  assert.match(inputPrecisionDescription(frame.provenance), /Some pixels could not be recovered\./)
  assert.match(
    inputPrecisionDescription({ precision: 'rgba8-display', colorWarnings: ['png-palette-index'] }),
    /8-bit compatibility decode\nSome pixels/
  )
  assert.equal(
    inputPrecisionDescription({ sourceBits: 16, colorWarnings: ['png-zero-gamma'] }),
    'Decoded precision: 16-bit'
  )
})

test('independent libpng retains raw words and LCMS validates PNG gamma/chromaticities and GRAY curves', (t) => {
  const result = runPngColorExperiment()
  if (
    (result.status === 77 || result.error?.code === 'ENOENT') &&
    process.env.OPENLR_TEST_CMS !== '1' &&
    !process.env.OPENLR_LIBPNG_LIBRARY &&
    !process.env.OPENLR_LCMS_LIBRARY &&
    !process.env.OPENLR_CMS_PYTHON
  )
    return t.skip('Native libpng/LCMS/Python unavailable; OPENLR_TEST_CMS=1 requires the independent check')
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error))
  const measured = JSON.parse(result.stdout)
  assert.equal(Object.keys(measured.metrics).length, 11)
  assert.ok(Object.values(measured.metrics).every((m) => m.raw16Exact))
  t.diagnostic(result.stdout.trim())
})
