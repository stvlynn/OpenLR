import test from 'node:test'
import assert from 'node:assert/strict'
import { validateRgbProfile } from '../web/color-profile.js'
import { COLOR_SPACES, makeColorProfile } from '../web/color-spaces.js'

function locate(bytes, id) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < view.getUint32(128); i++) {
    const entry = 132 + i * 12
    if (String.fromCharCode(...bytes.subarray(entry, entry + 4)) === id)
      return { entry, offset: view.getUint32(entry + 4), size: view.getUint32(entry + 8) }
  }
  throw Error('Missing test tag: ' + id)
}

function corrupt(change) {
  const bytes = makeColorProfile('display-p3')
  change(bytes, new DataView(bytes.buffer))
  return bytes
}

function writeSignature(bytes, at, id) {
  bytes.set(new TextEncoder().encode(id), at)
}

test('all generated RGB profiles validate, preserve legal shared payloads and return exact owned slices', () => {
  for (const id of Object.keys(COLOR_SPACES)) {
    const original = makeColorProfile(id),
      container = new Uint8Array(original.length + 19)
    container.set(original, 7)
    const result = validateRgbProfile(container.subarray(7))
    assert.deepEqual(result, original)
    assert.notEqual(result.buffer, container.buffer)
    assert.deepEqual(validateRgbProfile(original.buffer), original)
    assert.deepEqual(validateRgbProfile(new Uint8ClampedArray(original)), original)
  }
  const shared = corrupt((bytes, view) => {
    const source = locate(bytes, 'rTRC')
    for (const id of ['gTRC', 'bTRC']) {
      const destination = locate(bytes, id)
      view.setUint32(destination.entry + 4, source.offset)
      view.setUint32(destination.entry + 8, source.size)
    }
  })
  assert.deepEqual(validateRgbProfile(shared), shared)
})

test('rejects malformed headers, declared sizes, oversized tag counts and invalid PCS', () => {
  for (const value of [null, [], 'ICC', new Uint8Array(131)])
    assert.throws(() => validateRgbProfile(value), /Invalid RGB ICC profile/)
  for (const change of [
    (_, view) => view.setUint32(0, 128),
    (bytes, view) => view.setUint32(0, bytes.length + 4),
    (bytes, view) => view.setUint32(0, bytes.length - 1),
    (bytes) => writeSignature(bytes, 36, 'oops'),
    (bytes) => writeSignature(bytes, 16, 'CMYK'),
    (bytes) => writeSignature(bytes, 20, 'RGB '),
    (bytes) => (bytes[8] = 5),
    (_, view) => view.setUint32(128, 65535),
    (_, view) => view.setUint32(128, 0),
    (_, view) => view.setUint32(0, 132)
  ])
    assert.throws(() => validateRgbProfile(corrupt(change)), /Invalid RGB ICC profile/)
  const lab = corrupt((bytes) => writeSignature(bytes, 20, 'Lab '))
  assert.deepEqual(validateRgbProfile(lab), lab)
})

test('rejects duplicate signatures, out-of-profile or header-overlapping payloads and unaligned offsets', () => {
  for (const change of [
    (bytes) => bytes.set(bytes.subarray(132, 136), 144),
    (_, view) => view.setUint32(136, 0),
    (_, view) => view.setUint32(136, 133),
    (bytes, view) => view.setUint32(136, bytes.length),
    (_, view) => view.setUint32(140, 7),
    (_, view) => view.setUint32(140, 0xffffffff),
    (bytes, view) => view.setUint32(locate(bytes, 'rXYZ').offset + 4, 1)
  ])
    assert.throws(() => validateRgbProfile(corrupt(change)), /Invalid RGB ICC profile/)
  const padded = new Uint8Array(makeColorProfile().length + 128)
  padded.set(makeColorProfile())
  const view = new DataView(padded.buffer)
  view.setUint32(136, makeColorProfile().length)
  assert.throws(() => validateRgbProfile(padded), /payload bounds/)
})

test('checks XYZ and adaptation payload lengths and matrix/TRC tag types', () => {
  for (const change of [
    (bytes, view) => view.setUint32(locate(bytes, 'rXYZ').entry + 8, 16),
    (bytes) => writeSignature(bytes, locate(bytes, 'rXYZ').offset, 'curv'),
    (bytes, view) => view.setUint32(locate(bytes, 'chad').entry + 8, 40),
    (bytes) => writeSignature(bytes, locate(bytes, 'chad').offset, 'XYZ '),
    (bytes) => writeSignature(bytes, locate(bytes, 'rTRC').offset, 'sf32')
  ])
    assert.throws(() => validateRgbProfile(corrupt(change)), /Invalid RGB ICC profile/)
})

test('rejects truncated, unknown, undefined and non-finite parametric curves', () => {
  for (const change of [
    (bytes, view) => view.setUint32(locate(bytes, 'rTRC').entry + 8, 12),
    (bytes, view) => view.setUint16(locate(bytes, 'rTRC').offset + 8, 5),
    (bytes, view) => view.setUint16(locate(bytes, 'rTRC').offset + 10, 1),
    (bytes, view) => view.setInt32(locate(bytes, 'rTRC').offset + 12, 0),
    (bytes, view) => view.setInt32(locate(bytes, 'rTRC').offset + 16, -65536),
    (bytes, view) => {
      const at = locate(bytes, 'rTRC').offset
      view.setInt32(at + 20, -65536)
      view.setInt32(at + 28, 0)
    },
    (bytes, view) => {
      const at = locate(bytes, 'rTRC').offset
      view.setInt32(at + 12, 32767 * 65536)
      view.setInt32(at + 16, 2 * 65536)
    }
  ])
    assert.throws(() => validateRgbProfile(corrupt(change)), /Invalid RGB ICC profile/)
})

test('all five ICC parametric functions accept their exact parameter counts', () => {
  const definitions = [[2.2], [2.2, 1, 0], [2.2, 1, 0, 0], [2.4, 1, 0, 1, 0.04], [2.4, 1, 0, 1, 0.04, 0, 0]]
  for (const [type, parameters] of definitions.entries()) {
    const original = makeColorProfile(),
      size = 12 + parameters.length * 4
    const bytes = new Uint8Array(original.length + ((size + 3) & ~3))
    bytes.set(original)
    const view = new DataView(bytes.buffer),
      entry = locate(bytes, 'rTRC').entry
    view.setUint32(0, bytes.length)
    view.setUint32(entry + 4, original.length)
    view.setUint32(entry + 8, size)
    writeSignature(bytes, original.length, 'para')
    view.setUint16(original.length + 8, type)
    parameters.forEach((value, i) => view.setInt32(original.length + 12 + i * 4, Math.round(value * 65536)))
    assert.deepEqual(validateRgbProfile(bytes), bytes)
  }
})

test('sampled curves accept identity, positive gamma and full samples but reject inconsistent counts', () => {
  const sampled = (count, values) =>
    corrupt((bytes, view) => {
      const tag = locate(bytes, 'rTRC')
      writeSignature(bytes, tag.offset, 'curv')
      view.setUint32(tag.entry + 8, 12 + values.length * 2)
      view.setUint32(tag.offset + 8, count)
      values.forEach((value, i) => view.setUint16(tag.offset + 12 + i * 2, value))
    })
  for (const bytes of [sampled(0, []), sampled(1, [563]), sampled(3, [0, 32768, 65535])])
    assert.deepEqual(validateRgbProfile(bytes), bytes)
  for (const bytes of [sampled(3, [0]), sampled(1, [0]), sampled(0xffffffff, [])])
    assert.throws(() => validateRgbProfile(bytes), /Invalid RGB ICC profile/)
})

test('unknown LUT types receive outer structural checks without claiming semantic CMS validation', () => {
  const bytes = corrupt((data) => {
    const tag = locate(data, 'desc')
    writeSignature(data, tag.entry, 'A2B0')
    writeSignature(data, tag.offset, 'mAB ')
  })
  // Deliberately not a real LUT fixture. Passing it establishes only our stated
  // outer-validation boundary; the host CMS still owns interpretation/support.
  assert.deepEqual(validateRgbProfile(bytes), bytes)
})
