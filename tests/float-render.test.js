import test from 'node:test'
import assert from 'node:assert/strict'
import { renderFrame } from '../web/render.js'
import {
  assertLinearFrame,
  rgba8ToLinearFrame,
  linearFrameToRgba8,
  linearFrameToEncoded,
  sampleLinearRgba
} from '../web/pixel-frame.js'
import { validateLocalTool } from '../web/local-tools.js'

test('shared renderer recovers local highlights before output quantization and owns its samples', () => {
  const input = rgba8ToLinearFrame({
    width: 256,
    height: 1,
    data: Uint8ClampedArray.from({ length: 1024 }, (_, i) => (i % 4 === 3 ? 255 : Math.floor(i / 4)))
  })
  const original = input.data.slice()
  const mask = validateLocalTool('mask', {
    type: 'radial',
    center: { x: 0.5, y: 0.5 },
    rx: 1,
    ry: 1,
    feather: 0,
    opacity: 1,
    adjustments: { Exposure: 4 }
  })
  const output = renderFrame(input, { localTools: { masks: [mask] }, Exposure: -4 })
  assert.deepEqual(input.data, original)
  assert.notEqual(output.data, input.data)
  const bytes = linearFrameToRgba8(output).data
  assert.equal(new Set(Array.from({ length: 256 }, (_, i) => bytes[i * 4])).size, 256)
  for (let i = 0; i < 256; i++) assert.equal(bytes[i * 4], i)
  input.data[0] = -0.25
  input.data[1] = 3.5
  const extended = renderFrame(input, { localTools: { masks: [mask] }, Exposure: -4, turn: 2 })
  assert.equal(extended.data[1020], -0.25)
  assert.equal(extended.data[1021], 3.5)
})

test('float renderer combines geometry and color without collapsing sub-byte input', () => {
  const input = {
    width: 2,
    height: 2,
    colorSpace: 'srgb-linear',
    data: Float32Array.from([
      0.2, 0.3, 0.4, 1, 0.20001, 0.30001, 0.40001, 1, 0.2, 0.3, 0.4, 1, 0.20001, 0.30001, 0.40001, 1
    ])
  }
  const edit = {
    Exposure: 0.5,
    Contrast: 12,
    Temperature: 5,
    Saturation: 3,
    flip: true,
    turn: 1,
    Texture: 5,
    Clarity: 4,
    Sharpening: 3
  }
  const output = renderFrame(input, edit)
  assertLinearFrame(output)
  assert.notEqual(output.data[0], output.data[8])
  assert.equal(output.data[3], 1)
  const encoded = linearFrameToEncoded(output, 'prophoto-rgb')
  assert.ok(encoded.data instanceof Uint16Array)
  assert.ok(encoded.data.some((value, index) => index % 4 !== 3 && value % 257 !== 0))
})

test('linear contract rejects malformed samples and treats invisible colors without interpolation bleed', () => {
  const frame = {
    width: 2,
    height: 1,
    colorSpace: 'srgb-linear',
    data: Float32Array.from([-1, 3, 0.2, 1, 90, -90, 20, 0])
  }
  assert.deepEqual([...sampleLinearRgba(frame, 0.5, 0)], [-1, 3, Math.fround(0.2), 0.5])
  assert.equal(sampleLinearRgba(frame, -1, 0), null)
  assert.equal(sampleLinearRgba(frame, -0.25, 0)[3], 0.75)
  assert.deepEqual([...sampleLinearRgba(frame, 1, 0)], [0, 0, 0, 0])
  for (const value of [NaN, Infinity]) {
    const bad = { ...frame, data: frame.data.slice() }
    bad.data[0] = value
    assert.throws(() => assertLinearFrame(bad), /sample/)
  }
  assert.throws(() => assertLinearFrame({ ...frame, width: 3 }), /dimensions/)
  const bad = { ...frame, data: frame.data.slice() }
  bad.data[3] = 1.1
  assert.throws(() => assertLinearFrame(bad), /sample/)
})
