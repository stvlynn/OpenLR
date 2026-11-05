import test from 'node:test'
import assert from 'node:assert/strict'
import { linearFrameToRgba8 } from '../web/pixel-frame.js'

function scalarSrgbSample(value) {
  const magnitude = Math.abs(value)
  const encoded = magnitude <= 0.0031308 ? magnitude * 12.92 : 1.055 * magnitude ** (1 / 2.4) - 0.055
  return Math.sign(value) * encoded * 255
}

function linearFromSrgb(encoded) {
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4
}

function adjacentFloat32(value) {
  const floats = Float32Array.of(value, value, value),
    bits = new Uint32Array(floats.buffer)
  bits[0]--
  bits[2]++
  return [...floats]
}

test('Float32 display encoding matches the scalar byte at all quantization boundaries and preserves a sliced frame', () => {
  const alpha = [0, 0.5, 1]
  const rows = Array.from({ length: 255 }, (_, code) => [
    ...adjacentFloat32(linearFromSrgb((code + 0.5) / 255)),
    alpha[code % alpha.length]
  ])
  // Also exercise each bin away from its transitions, where a lookup can avoid scalar encoding.
  for (let code = 0; code <= 255; code++)
    rows.push([
      linearFromSrgb(code / 255),
      linearFromSrgb((255 - code) / 255),
      linearFromSrgb(((code * 17) % 256) / 255),
      alpha[code % alpha.length]
    ])
  rows.push(
    [...adjacentFloat32(0.0031308), 1],
    [...adjacentFloat32(1), 0.5],
    [0, -0, 2 ** -149, 0],
    [-(2 ** -149), -0.4, 3.5, 1],
    [2 ** -126, 2 ** -13, 2 ** 127, 0.5]
  )
  const backing = new Float32Array(rows.length * 4 + 8).fill(-15),
    data = backing.subarray(3, -5)
  data.set(rows.flat())
  const before = backing.slice()
  const expected = Uint8ClampedArray.from(data, (value, index) =>
    index % 4 === 3 ? 255 * value : scalarSrgbSample(value)
  )
  for (let code = 0; code < 255; code++) {
    assert.equal(expected[code * 4], code)
    assert.equal(expected[code * 4 + 2], code + 1)
  }

  assert.deepEqual(linearFrameToRgba8({ width: rows.length, height: 1, colorSpace: 'srgb-linear', data }), {
    width: rows.length,
    height: 1,
    data: expected
  })
  assert.deepEqual(backing, before)
})

test('pixel reader RGB rounds through Float32 while alpha remains the source alpha', () => {
  const justBelowFirstThreshold = linearFromSrgb(0.5 / 255) * (1 - 1e-10)
  assert.deepEqual(
    Uint8ClampedArray.of(
      scalarSrgbSample(justBelowFirstThreshold),
      scalarSrgbSample(Math.fround(justBelowFirstThreshold))
    ),
    Uint8ClampedArray.of(0, 1)
  )
  const values = [
    [justBelowFirstThreshold, NaN, Infinity, 1],
    [-Infinity, -0, 1.2, 1],
    [-0.2, 0.2, 0.8, 0]
  ]
  const data = Float32Array.of(0.1, 0.2, 0.3, 0.5, 0.4, 0.5, 0.6, 0, 0.7, 0.8, 0.9, 1)
  const before = data.slice()
  const frame = { width: 1, height: 3, colorSpace: 'srgb-linear', data }
  const result = linearFrameToRgba8(frame, (source, index, out, offset) => {
    assert.equal(source, data)
    out.set(values[index / 4], offset)
  })
  const expected = Uint8ClampedArray.from(
    values.flatMap(([r, g, b], index) => [
      scalarSrgbSample(Math.fround(r)),
      scalarSrgbSample(Math.fround(g)),
      scalarSrgbSample(Math.fround(b)),
      255 * before[index * 4 + 3]
    ])
  )
  assert.deepEqual(result, { width: 1, height: 3, data: expected })
  assert.deepEqual(data, before)
})

test('display encoding without a reader keeps the existing linear-frame validation', () => {
  const frame = { width: 1, height: 1, colorSpace: 'srgb-linear', data: Float32Array.of(0, 0.5, 1, 1) }
  for (const changes of [{ width: 0 }, { height: 2 }, { data: new Float32Array(3) }])
    assert.throws(() => linearFrameToRgba8({ ...frame, ...changes }), /Invalid pixel frame dimensions/)
  for (const changes of [{ colorSpace: 'srgb' }, { data: new Float64Array(4) }])
    assert.throws(() => linearFrameToRgba8({ ...frame, ...changes }), /Expected a linear sRGB Float32 frame/)
  for (const [index, value] of [
    [0, NaN],
    [1, Infinity],
    [2, -Infinity],
    [3, NaN],
    [3, -0.1],
    [3, 1.1]
  ]) {
    const data = frame.data.slice()
    data[index] = value
    assert.throws(() => linearFrameToRgba8({ ...frame, data }), /Invalid linear pixel sample/)
  }
})
