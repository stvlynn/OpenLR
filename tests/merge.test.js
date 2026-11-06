import test from 'node:test'
import assert from 'node:assert/strict'
import cvModule from '@techstark/opencv-js'
import { mergeHDR, mergePanorama, project, exposureOffsets } from '../web/merge-core.js'
import { frame, scene } from './fixtures/merge-scene.js'
import { decodeRadiance } from './fixtures/radiance.mjs'
const cv = await cvModule

test('independent RGBE reader checks scanline lengths and payload bounds', () => {
  const header = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n')
  const row = Buffer.from([2, 2, 0, 8, 136, 64, 136, 128, 136, 192, 136, 129])
  const bytes = Buffer.concat([header, row])
  const decoded = decodeRadiance(bytes)
  assert.deepEqual([decoded.width, decoded.height], [8, 1])
  assert.deepEqual([...decoded.pixels], Array.from({ length: 8 }, () => [0.5, 1, 1.5]).flat())
  assert.throws(() => decodeRadiance(bytes.subarray(0, -1)), /exceeds its encoded data/)
  const invalidRun = Buffer.from(bytes)
  invalidRun[header.length + 4] = 137
  assert.throws(() => decodeRadiance(invalidRun), /packet length/)
  assert.throws(() => decodeRadiance(Buffer.concat([bytes, Buffer.of(0)])), /after the last/)
})

test('HDR aligns displaced real exposure brackets and preserves recoverable radiance above display white', () => {
  const frames = [
    frame(600, 260, { ev: -2, x: 5, y: -3, hdr: true }),
    frame(600, 260, { ev: 0, hdr: true }),
    frame(600, 260, { ev: 2, x: -4, y: 2, hdr: true })
  ]
  const result = mergeHDR(cv, frames)
  assert.ok(result.diagnostics.dynamicRangeStops > 8)
  assert.ok(result.diagnostics.maxRadiance > 1)
  for (const alignment of result.diagnostics.alignment) {
    const [x, y] = project(alignment.matrix, 100, 100),
      expected = alignment.source === 0 ? [105, 97] : [96, 102]
    assert.ok(Math.hypot(x - expected[0], y - expected[1]) < 2, JSON.stringify(alignment))
    assert.ok(alignment.inliers >= 12)
  }
  const hdr = decodeRadiance(result.radiance)
  assert.equal(hdr.width, result.width)
  const x = Math.floor(result.width * 0.82),
    y = Math.floor(result.height * 0.48),
    expected = scene(result.diagnostics.crop.x + x, result.diagnostics.crop.y + y, true)
  for (let c = 0; c < 3; c++)
    assert.ok(Math.abs(hdr.pixels[(y * hdr.width + x) * 3 + c] - expected[c]) / expected[c] < 0.12)
  assert.ok(result.data.some((value, i) => i % 4 !== 3 && value > 40 && value < 230))
})

test('panorama registers genuinely overlapping image regions instead of concatenating frames', () => {
  const frames = [
    frame(360, 260, { x: 0 }),
    frame(360, 260, { x: 180, y: 7 }),
    frame(360, 260, { x: 360, y: -4 })
  ]
  const result = mergePanorama(cv, frames)
  assert.ok(Math.abs(result.width - 720) < 8)
  assert.ok(result.height >= 260 && result.height < 285)
  const [x, y] = project(result.diagnostics.transforms[2], 100, 100)
  assert.ok(Math.hypot(x - 460, y - 96) < 3)
  const origin = result.diagnostics.bounds
  let error = 0,
    count = 0
  for (let sy = 40; sy < 210; sy += 13)
    for (let sx = 20; sx < 700; sx += 17) {
      const i = ((sy - origin.top) * result.width + sx - origin.left) * 4
      if (result.data[i + 3] !== 255) continue
      const reference = frame(1, 1, { x: sx, y: sy }).data
      for (let c = 0; c < 3; c++) {
        error += Math.abs(result.data[i + c] - reference[c])
        count++
      }
    }
  assert.ok(error / count < 9, 'Mean absolute channel error ' + error / count)
})

test('merge rejects missing exposure calibration, nonoverlap, flat images, and invalid bracket values', () => {
  assert.throws(() => exposureOffsets([{ metadata: {} }, { metadata: {} }]), /exposure time/)
  assert.throws(() => exposureOffsets([{}, {}], [0, 0]), /distinct/)
  assert.throws(() => exposureOffsets([{}, {}], [0, Infinity]), /finite/)
  assert.throws(
    () => mergePanorama(cv, [frame(300, 220, { flat: true }), frame(300, 220, { flat: true })]),
    /no reliable/
  )
  assert.throws(
    () => mergePanorama(cv, [frame(360, 260, { x: 0 }), frame(360, 260, { x: 1500 })]),
    /no reliable/
  )
  assert.throws(
    () =>
      mergeHDR(cv, [frame(300, 220, { hdr: true, ev: -2 }), frame(300, 220, { hdr: true, ev: 2 })], {
        evs: [0, 1],
        align: false
      }),
    /disagree/
  )
})

test('linear RAW samples retain sub-eight-bit differences through radiance recovery', () => {
  const frames = [0, 1].map((ev) => {
    const source = frame(8, 4, { flat: true }),
      values = new Float32Array(8 * 4 * 3)
    for (let i = 0; i < values.length; i++)
      values[i] = (0.100001 + (Math.floor(i / 3) % 2) * 0.000008) * 2 ** ev
    return { ...source, linear: values }
  })
  const result = mergeHDR(cv, frames, { evs: [0, 1], align: false })
  assert.deepEqual(result.diagnostics.inputTransfer, ['linear16-RAW', 'linear16-RAW'])
  assert.ok(result.diagnostics.maxRadiance - result.diagnostics.minRadiance > 0.00001)
  assert.ok(result.diagnostics.maxRadiance - result.diagnostics.minRadiance < 0.00003)
})
