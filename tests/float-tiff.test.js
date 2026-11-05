import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import UTIF from '../web/vendor/codecs/utif.js'
import { encodeColorTiff, encodeColorPng } from '../web/color-containers.js'
import { makeColorProfile, encodeSrgb } from '../web/color-spaces.js'
import { resizeFrame } from '../web/frame-geometry.js'

function readTiff(encoded) {
  const buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
    ifd = UTIF.decode(buffer)[0]
  UTIF.decodeImage(buffer, ifd)
  const view = new DataView(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength)
  return {
    ifd,
    samples: Uint16Array.from({ length: ifd.data.byteLength / 2 }, (_, i) => view.getUint16(i * 2, true))
  }
}

test('16-bit TIFF independently decodes every low sample bit, alpha, profile and multi-strip byte count', () => {
  for (const [width, height] of [
    [1, 1],
    [17, 513]
  ]) {
    // A sliced view catches accidentally writing an entire backing buffer.
    const storage = new Uint16Array(width * height * 4 + 8),
      data = storage.subarray(4, storage.length - 4)
    data.set([1, 255, 65534, 32769])
    for (let i = 4; i < data.length; i++) data[i] = (i * 149 + ((i >>> 2) % 251)) & 65535
    const source = data.slice(),
      profile = Uint8Array.from({ length: 170003 }, (_, i) => (i * 59) & 255),
      encoded = encodeColorTiff({ width, height, data }, profile),
      { ifd, samples } = readTiff(encoded)
    assert.deepEqual(ifd.t258, [16, 16, 16, 16])
    assert.deepEqual(ifd.t338, [2])
    assert.deepEqual(ifd.t262, [2])
    assert.deepEqual(ifd.t277, [4])
    assert.deepEqual(ifd.t284, [1])
    assert.deepEqual(samples, source)
    assert.deepEqual(data, source)
    assert.equal(ifd.t273.length, Math.ceil(height / 256))
    assert.equal(
      ifd.t279.reduce((total, value) => total + value, 0),
      data.byteLength
    )
    for (let i = 0; i < ifd.t273.length; i++) {
      assert.equal(ifd.t279[i], width * Math.min(256, height - i * 256) * 8)
      assert.ok(ifd.t273[i] % 2 === 0)
      assert.ok(ifd.t273[i] + ifd.t279[i] <= encoded.byteLength)
      if (i) assert.equal(ifd.t273[i], ifd.t273[i - 1] + ifd.t279[i - 1])
    }
    const view = new DataView(encoded.buffer),
      start = view.getUint32(4, true),
      count = view.getUint16(start, true)
    let found = false
    for (let i = 0; i < count; i++) {
      const at = start + 2 + i * 12
      if (view.getUint16(at, true) !== 34675) continue
      assert.equal(view.getUint16(at + 2, true), 7)
      assert.equal(view.getUint32(at + 4, true), profile.byteLength)
      const offset = view.getUint32(at + 8, true)
      assert.deepEqual(encoded.subarray(offset, offset + profile.byteLength), profile)
      found = true
    }
    assert.ok(found)
    const first = ifd.t273[0]
    assert.deepEqual([...encoded.subarray(first, first + 8)], [1, 0, 255, 0, 254, 255, 1, 128])
  }
})

test('float resampling to 16-bit TIFF preserves differences hidden by an 8-bit view', () => {
  const source = {
      width: 2,
      height: 1,
      colorSpace: 'srgb-linear',
      data: Float32Array.of(0.10001, 0.3, 0.7, 1, 0.10003, 0.3, 0.7, 1)
    },
    edited = resizeFrame(source, 3, 1),
    target = {
      width: edited.width,
      height: edited.height,
      data: Uint16Array.from(edited.data, (v, i) => Math.round(65535 * (i % 4 === 3 ? v : encodeSrgb(v))))
    },
    profile = makeColorProfile('srgb'),
    encoded = encodeColorTiff(target, profile),
    { ifd, samples } = readTiff(encoded)
  assert.equal(Math.round(encodeSrgb(source.data[0]) * 255), Math.round(encodeSrgb(source.data[4]) * 255))
  assert.ok(samples[0] < samples[4] && samples[4] < samples[8])
  assert.deepEqual(samples, target.data)
  assert.deepEqual(Uint8Array.from(ifd.t34675), profile)
})

test('TIFF retains the exact legacy 8-bit serialization and rejects mismatched typed samples', () => {
  const frame = {
      width: 3,
      height: 2,
      data: Uint8ClampedArray.from({ length: 24 }, (_, i) => (i * 37 + 11) % 256)
    },
    profile = makeColorProfile('display-p3'),
    encoded = encodeColorTiff(frame, profile)
  assert.equal(
    createHash('sha256').update(encoded).digest('hex'),
    '23ca19d9240db02cf7ba92b98613b00c3e5b601250193f96e78b4be3a1a01612'
  )
  assert.throws(
    () => encodeColorTiff({ width: 1, height: 1, data: new Uint16Array(3) }, profile),
    /complete/i
  )
  assert.throws(() => encodeColorTiff({ width: 1, height: 1, data: new Float32Array(4) }, profile), /bytes/)
  assert.throws(() => encodeColorPng({ width: 1, height: 1, data: new Uint16Array(4) }, profile), /bytes/)
})
