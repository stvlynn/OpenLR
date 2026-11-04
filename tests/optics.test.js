import test from 'node:test'
import assert from 'node:assert/strict'
import {
  warpOptics,
  compileOptics,
  validateOptics,
  matchLensProfiles,
  lensProfile,
  straighten,
  listLensProfiles
} from '../web/optics.js'
import { viewToOriginal, originalToView } from '../web/local-tools-ui.js'
import { applyLocalTools } from '../web/local-tools.js'

function grid(width, height, map = (point) => point, chromatic = [1, 1, 1]) {
  const data = new Uint8ClampedArray(width * height * 4),
    lines = [0.22, 0.5, 0.78]
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        const point = map({
          x: (x + 0.5 - width / 2) / chromatic[c] + width / 2,
          y: (y + 0.5 - height / 2) / chromatic[c] + height / 2
        })
        const distance = Math.min(...lines.map((line) => Math.abs(point.x - width * line)))
        data[(y * width + x) * 4 + c] = 15 + 230 * Math.exp((-distance * distance) / (2 * 0.75 * 0.75))
      }
      data[(y * width + x) * 4 + 3] = 255
    }
  return { width, height, data }
}
function peak(image, y, around, channel = 1, radius = 20) {
  let best = -1,
    position = 0
  for (let x = Math.max(0, around - radius); x < Math.min(image.width, around + radius); x++)
    if (image.data[(y * image.width + x) * 4 + channel] > best) {
      best = image.data[(y * image.width + x) * 4 + channel]
      position = x
    }
  return position
}
function deviation(image, x) {
  return Math.max(
    ...[20, 45, 70, 100, 130, 155, 179]
      .filter((y) => y < image.height)
      .map((y) => Math.abs(peak(image, y, x) - x))
  )
}

test('radial resampling straightens a genuinely barrel-distorted line grid', () => {
  const width = 300,
    height = 200,
    k = -0.07,
    short = height / 2
  const distorted = grid(width, height, (point) => {
    const x = (point.x - width / 2) / short,
      y = (point.y - height / 2) / short,
      r = Math.hypot(x, y)
    let low = 0,
      high = 2.17
    for (let i = 0; i < 50; i++) {
      const mid = (low + high) / 2
      if (mid * (1 + k * mid * mid) < r) low = mid
      else high = mid
    }
    const factor = r ? (low + high) / (2 * r) : 1
    return { x: x * factor * short + width / 2, y: y * factor * short + height / 2 }
  })
  const corrected = warpOptics(distorted, { manualDistortion: -70 })
  const x = Math.round(width * 0.22)
  assert.ok(deviation(distorted, x) >= 3)
  assert.ok(deviation(corrected, x) <= 1)
})

test('channel-specific TCA remapping removes simulated red/blue magnification fringes', () => {
  const image = grid(480, 320, (point) => point, [1.01, 1, 0.99]),
    x = Math.round(480 * 0.22),
    y = 160
  const before = Math.abs(peak(image, y, x, 0) - peak(image, y, x, 2))
  const corrected = warpOptics(image, { redScale: 100, blueScale: -100 })
  const after = Math.abs(peak(corrected, y, x, 0) - peak(corrected, y, x, 2))
  assert.ok(before >= 2)
  assert.ok(after <= 1)
})

test('a projective inverse corrects known keystone geometry and keeps missing edges transparent', () => {
  const width = 300,
    height = 200,
    k = 0.1,
    short = height / 2
  const image = grid(width, height, (point) => {
    const x = (point.x - width / 2) / short,
      y = (point.y - height / 2) / short,
      z = 1 + k * y
    return { x: (x / z) * short + width / 2, y: (y / z) * short + height / 2 }
  })
  const corrected = warpOptics(image, { vertical: 20 }),
    x = Math.round(width * 0.22)
  assert.ok(deviation(image, x) >= 5)
  assert.ok(deviation(corrected, x) <= 1)
  assert.ok(corrected.data.some((value, i) => i % 4 === 3 && value === 0))
})

test('real profile metadata, focal samples, crop normalization and calibration boundaries are explicit', () => {
  assert.ok(listLensProfiles().length > 400)
  const matched = matchLensProfiles({ Make: 'Canon', Model: 'Canon PowerShot G1' })
  assert.equal(matched.profiles.length, 1)
  assert.equal(matched.cameras[0].cropFactor, 4.843)
  const profile = lensProfile(matched.profiles[0].id, 7, 4.843)
  assert.equal(profile.license, 'CC-BY-SA-3.0')
  assert.equal(profile.distortion.a, 0.013759)
  const map = compileOptics({ width: 400, height: 300 }, { profile }),
    point = { x: 0.8, y: 0.6 },
    r = Math.hypot(0.8, 0.2)
  const a = 0.013759,
    b = -0.037638,
    d = 1 - a - b,
    factor = 1 + (a / d ** 4) * r ** 3 + (b / d ** 3) * r * r
  const expected = { x: 0.5 + 0.3 * factor, y: 0.5 + 0.1 * factor },
    actual = map.toOriginal(point)
  assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-12)
  assert.deepEqual(lensProfile(profile.id, 8, 4.843).distortion.sampleRange, [7, 9.344])
  assert.throws(() => lensProfile(profile.id, 70, 4.843), /outside/)
  assert.throws(() => lensProfile(profile.id, 7, 1), /calibrated/)
  assert.throws(() => validateOptics({ scale: 0 }), /between/)
  assert.throws(() => compileOptics({ width: 4000, height: 100 }, { horizontal: 50 }), /horizon/)
  assert.throws(
    () =>
      compileOptics({ width: 300, height: 200 }, { manualDistortion: -100, horizontal: 40, vertical: 40 }),
    /folded|horizon/
  )
})

test('local-tool coordinates round trip through optics, crop, flip and all rotations, including transparent boundaries', () => {
  const image = { width: 300, height: 200 },
    optics = {
      manualDistortion: -30,
      vertical: 8,
      horizontal: -7,
      rotate: 13,
      scale: 120,
      aspect: 110,
      shiftX: 3,
      shiftY: -2
    }
  for (let turn = 0; turn < 4; turn++)
    for (const flip of [false, true]) {
      const edit = { optics, crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 }, turn, flip }
      for (const point of [
        { x: 0.3, y: 0.3 },
        { x: 0.5, y: 0.5 },
        { x: 0.7, y: 0.6 }
      ]) {
        const original = viewToOriginal(point, image, edit),
          view = originalToView(original, image, edit)
        assert.ok(Math.hypot(view.x - point.x, view.y - point.y) < 1e-10)
      }
    }
  assert.equal(viewToOriginal({ x: 0, y: 0 }, image, { optics: { rotate: 45 } }), null)
  const pixels = {
      ...image,
      data: Uint8ClampedArray.from({ length: 300 * 200 * 4 }, (_, i) => (i % 4 === 3 ? 255 : 100))
    },
    center = { x: 0.3, y: 0.4 }
  applyLocalTools(pixels, {
    masks: [
      { type: 'radial', center, rx: 0.06, ry: 0.08, feather: 0, opacity: 1, adjustments: { Exposure: 1 } }
    ]
  })
  const corrected = warpOptics(pixels, optics),
    target = compileOptics(image, optics).fromOriginal(center)
  const at = (Math.round(target.y * 200 - 0.5) * 300 + Math.round(target.x * 300 - 0.5)) * 4
  assert.ok(corrected.data[at] > 130)
})

test('straightening computes an actual rotation from the chosen line', () => {
  const image = { width: 400, height: 300 },
    start = { x: 0.2, y: 0.3 },
    end = { x: 0.8, y: 0.55 },
    recipe = { vertical: 8, horizontal: -5, aspect: 120 }
  const next = straighten(image, recipe, start, end),
    map = compileOptics(image, next),
    a = map.fromOriginal(start),
    b = map.fromOriginal(end)
  assert.ok(Math.abs(a.y - b.y) < 1e-10)
  const vertical = straighten(image, recipe, start, end, 'vertical'),
    verticalMap = compileOptics(image, vertical)
  assert.ok(Math.abs(verticalMap.fromOriginal(start).x - verticalMap.fromOriginal(end).x) < 1e-10)
  assert.throws(() => straighten(image, {}, start, start), /distinct/)
})
