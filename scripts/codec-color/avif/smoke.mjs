// Exercises compiled WASM, its native-sample contract and actual AVIF colr boxes.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makeColorProfile, convertSrgbPixels } from '../../../web/color-spaces.js'
import { defaultOptions } from '../../../node_modules/@jsquash/avif/meta.js'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const work = process.env.OPENLR_AVIF_BUILD_DIR || resolve(workspace, '.tools/codec-color/avif')
async function load(relative) {
  const script = join(work, 'output', relative)
  const { default: factory } = await import(pathToFileURL(script))
  return factory({ wasmBinary: await readFile(script.replace(/\.js$/, '.wasm')) })
}
function findBoxes(bytes, wanted, start = 0, end = bytes.length, result = []) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = start; offset < end;) {
    assert.ok(offset + 8 <= end, 'complete BMFF header')
    const size = view.getUint32(offset)
    const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    assert.ok(size >= 8 && offset + size <= end, `valid ${kind} bounds`)
    if (kind === wanted) result.push(bytes.slice(offset + 8, offset + size))
    else if (['meta', 'iprp', 'ipco'].includes(kind))
      findBoxes(bytes, wanted, offset + (kind === 'meta' ? 12 : 8), offset + size, result)
    offset += size
  }
  return result
}
// Fixture inspector, not a general AV1 parser. AV1 section 5.5 reduced-still
// sequence syntax; reads the actual first color OBU in mdat independently of colr.
function stillBitstreamColor(bytes) {
  const payload = findBoxes(bytes, 'mdat')[0]
  assert.ok(payload, 'actual AV1 mdat')
  for (let offset = 0; offset < payload.length;) {
    const header = payload[offset++]
    assert.equal(header & 0x81, 0, 'valid OBU header')
    if (header & 4) offset++
    assert.ok(header & 2, 'OBU has explicit size')
    let size = 0,
      shift = 0,
      next
    do {
      next = payload[offset++]
      size += (next & 127) * 2 ** shift
      shift += 7
    } while (next & 128)
    assert.ok(offset + size <= payload.length, 'OBU bounds')
    if (((header >> 3) & 15) === 1) {
      const sequence = payload.subarray(offset, offset + size)
      let bit = 0
      const read = (count) => {
        assert.ok(bit + count <= sequence.length * 8, 'sequence bounds')
        let value = 0
        while (count--) {
          value = value * 2 + ((sequence[bit >> 3] >> (7 - (bit & 7))) & 1)
          bit++
        }
        return value
      }
      const profile = read(3)
      assert.equal(read(1), 1, 'still picture')
      assert.equal(read(1), 1, 'reduced still header')
      read(5) // level
      const widthBits = read(4) + 1,
        heightBits = read(4) + 1
      read(widthBits)
      read(heightBits)
      read(6) // superblock/filter and superres/cdef/restoration flags
      assert.equal(read(1), 0, '8-bit fixture')
      const monochrome = profile === 1 ? 0 : read(1)
      const [cp, tc, mc] = read(1) ? [read(8), read(8), read(8)] : [2, 2, 2]
      const fullRange = !monochrome && cp === 1 && tc === 13 && mc === 0 ? true : !!read(1)
      // libavif may store the separate monochrome alpha item first in mdat.
      if (!monochrome) return [cp, tc, mc, fullRange]
    }
    offset += size
  }
  throw new Error('Missing AV1 sequence header')
}
const encoder = await load('enc/avif_enc.js')
const decoder = await load('dec/avif_dec.js')
const width = 32,
  height = 24
const data = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => (i * 41 + (i >> 2) * 13) % 256)
const options = {
  ...defaultOptions,
  quality: 100,
  qualityAlpha: -1,
  subsample: 3,
  speed: 10,
  icc: new Uint8Array(),
  colorPrimaries: 2,
  transferCharacteristics: 2,
  matrixCoefficients: -1,
  fullRange: true
}
await mkdir(join(work, 'fixtures'), { recursive: true })
await writeFile(join(work, 'fixtures', 'source.rgba'), data)
for (const target of ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020']) {
  const converted = convertSrgbPixels({ data, width, height }, target)
  const icc = makeColorProfile(target)
  const bytes = encoder.encode(new Uint8Array(converted.data.buffer), width, height, { ...options, icc })
  assert.ok(bytes?.length > 0, `${target}: actual encode`)
  const native = decoder.decodeWithColor(bytes, 8)
  assert.equal(native.width, width)
  assert.equal(native.height, height)
  assert.deepEqual(
    new Uint8Array(native.data),
    new Uint8Array(converted.data),
    `${target}: exact native lossless samples`
  )
  assert.deepEqual(native.icc, icc, `${target}: exact ICC from decoder`)
  assert.deepEqual(
    [native.colorPrimaries, native.transferCharacteristics, native.matrixCoefficients, native.fullRange],
    [2, 2, 0, true]
  )
  const boxes = findBoxes(bytes, 'colr')
  const signature = (box) => String.fromCharCode(...box.subarray(0, 4))
  assert.deepEqual(boxes.find((box) => ['prof', 'rICC'].includes(signature(box)))?.subarray(4), icc)
  const nclx = boxes.find((box) => signature(box) === 'nclx')
  assert.ok(nclx, 'actual nclx')
  assert.deepEqual(Array.from(nclx.subarray(4)), [0, 2, 0, 2, 0, 0, 128])
  assert.deepEqual(stillBitstreamColor(bytes), [2, 2, 0, true], 'actual AV1 bitstream CICP')
  await writeFile(join(work, 'fixtures', `${target}.avif`), bytes)
  await writeFile(join(work, 'fixtures', `${target}.rgba`), converted.data)
  await writeFile(join(work, 'fixtures', `${target}.icc`), icc)
  console.log(`${target}: ${bytes.length} bytes, native samples/ICC/nclx exact`)
}
assert.equal(decoder.decodeWithColor(Uint8Array.of(1, 2, 3), 8), null, 'corrupt input fails')
assert.equal(encoder.encode(new Uint8Array(3), width, height, options), null, 'invalid buffer length fails')
const lossy = encoder.encode(new Uint8Array(data.buffer), width, height, {
  ...options,
  quality: 70,
  subsample: 1,
  colorPrimaries: 1,
  transferCharacteristics: 13
})
const lossyDecoded = decoder.decodeWithColor(lossy, 8)
assert.deepEqual(
  [
    lossyDecoded.colorPrimaries,
    lossyDecoded.transferCharacteristics,
    lossyDecoded.matrixCoefficients,
    lossyDecoded.fullRange
  ],
  [1, 13, 6, true]
)
assert.deepEqual(stillBitstreamColor(lossy), [1, 13, 6, true], 'lossy actual AV1 bitstream CICP')
console.log('lossy CICP and visible failure boundary verified')
