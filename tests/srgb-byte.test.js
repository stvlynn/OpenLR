import test from 'node:test'
import assert from 'node:assert/strict'
import { SRGB8_LINEAR } from '../web/color-spaces.js'
import { rgba8ToLinearFrame } from '../web/pixel-frame.js'

test('shared byte transfer preserves every code, alpha and typed-array slice exactly', () => {
  const reference = (value) => {
    const v = value / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  for (let code = 0; code < 256; code++) assert.equal(SRGB8_LINEAR[code], reference(code))
  for (const Type of [Uint8Array, Uint8ClampedArray]) {
    const backing = new Type(256 * 4 + 16),
      data = backing.subarray(8, -8)
    for (let i = 0; i < 256; i++) data.set([i, 255 - i, (i * 17) % 256, i], i * 4)
    const before = backing.slice(),
      output = rgba8ToLinearFrame({ width: 256, height: 1, data })
    for (let i = 0; i < data.length; i++)
      assert.equal(output.data[i], Math.fround(i % 4 === 3 ? data[i] / 255 : reference(data[i])))
    assert.deepEqual(backing, before)
  }
  assert.throws(() => rgba8ToLinearFrame({ width: 1, height: 1, data: new Float32Array(4) }), /RGBA8/)
  assert.throws(() => rgba8ToLinearFrame({ width: 1, height: 1, data: new Uint8Array(3) }), /dimensions/)
})
