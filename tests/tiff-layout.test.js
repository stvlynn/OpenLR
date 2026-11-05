import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import UTIF from '../web/vendor/codecs/utif.js'
import { makeTiffFixture } from './fixtures/tiff.mjs'
import { patchUtif } from '../scripts/patch-utif.mjs'
import { processCodec } from '../web/codec-kernel.js'

function check(options) {
  const { bytes, samples } = makeTiffFixture(options),
    original = bytes.slice()
  const image = UTIF.decode(bytes.buffer)[0]
  UTIF.decodeImage(bytes.buffer, image)
  const view = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  const actual = Array.from({ length: samples.length }, (_, i) =>
    options.bits === 16 ? view.getUint16(i * 2, true) : view.getUint8(i)
  )
  assert.deepEqual(actual, samples, JSON.stringify(options))
  assert.deepEqual(bytes, original)
}

test('pinned TIFF decoder retains all integer bits across 160 stripped layouts', () => {
  let count = 0
  for (const bits of [8, 16])
    for (const littleEndian of [true, false])
      for (const compression of [1, 5, 8, 32773])
        for (const predictor of [1, 2])
          for (const [photo, channels] of [
            [2, 3],
            [2, 4],
            [0, 1],
            [1, 1],
            [1, 2]
          ]) {
            check({
              bits,
              littleEndian,
              compression,
              predictor,
              photo,
              channels,
              alpha: channels === 4 || channels === 2 ? 2 : 0
            })
            count++
          }
  assert.equal(count, 160)
})

test('same TIFF decoder retains all integer bits across 896 padded/edge tiled layouts', () => {
  let count = 0
  for (const bits of [8, 16])
    for (const littleEndian of [true, false])
      for (const compression of [1, 5, 8, 32773])
        for (const predictor of [1, 2])
          for (const [width, height] of [
            [17, 18],
            [5, 4],
            [32, 32],
            [33, 2]
          ])
            for (const [photo, channels, alpha] of [
              [2, 3, 0],
              [2, 4, 1],
              [2, 4, 2],
              [0, 1, 0],
              [1, 1, 0],
              [1, 2, 1],
              [1, 2, 2]
            ]) {
              check({
                bits,
                littleEndian,
                compression,
                predictor,
                photo,
                channels,
                alpha,
                tileSize: 16,
                width,
                height
              })
              count++
            }
  assert.equal(count, 896)
})

test('truncated and missing-EOI LZW rejects promptly inside its declared block', async () => {
  const fixture = makeTiffFixture({ compression: 5, rowsPerStrip: 4 }),
    image = UTIF.decode(fixture.bytes.buffer)[0]
  for (const kind of ['missing-eoi', 'short-block']) {
    const bytes = fixture.bytes.slice(),
      off = image.t273[0],
      length = image.t279[0]
    if (kind === 'missing-eoi') bytes.fill(0, off, off + length)
    else bytes.fill(0, off + Math.floor(length / 2), off + length)
    const worker = new Worker(new URL('./fixtures/tiff-decode-worker.mjs', import.meta.url), {
      workerData: bytes.buffer
    })
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('TIFF LZW decoding did not terminate')), 3000)
        worker.once('message', (message) => {
          clearTimeout(timeout)
          resolve(message)
        })
        worker.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
      })
      assert.match(result.error, /TIFF LZW/)
    } finally {
      await worker.terminate()
    }
  }
  const truncated = fixture.bytes.slice(0, -3),
    ifd = UTIF.decode(truncated.buffer)[0]
  assert.throws(() => UTIF.decodeImage(truncated.buffer, ifd), /TIFF block input bounds/)
})

test('short or overflowing decoded blocks fail instead of fabricating zero samples', () => {
  for (const compression of [1, 8, 32773]) {
    const { bytes } = makeTiffFixture({ compression, rowsPerStrip: 4 })
    if (compression === 1) {
      const truncated = bytes.slice(0, -5),
        image = UTIF.decode(truncated.buffer)[0]
      assert.throws(() => UTIF.decodeImage(truncated.buffer, image), /TIFF block input bounds/)
      continue
    }
    const first = UTIF.decode(bytes.buffer)[0],
      offset = first.t273[0]
    // Replace the actual declared single compressed block in the generated file.
    const payloads =
      compression === 8
        ? [deflateSync(Uint8Array.of(1, 2, 3)), deflateSync(new Uint8Array(121))]
        : [Uint8Array.of(2, 1, 2, 3), Uint8Array.of(5, 1, 2), Uint8Array.of(136, 0)]
    for (const payload of payloads) {
      const malformed = bytes.slice(),
        view = new DataView(malformed.buffer)
      malformed.set(payload, offset)
      for (let i = 0; i < view.getUint16(8, true); i++) {
        const at = 10 + i * 12
        if (view.getUint16(at, true) === 279) view.setUint32(at + 8, payload.length, true)
      }
      const image = UTIF.decode(malformed.buffer)[0]
      assert.throws(() => UTIF.decodeImage(malformed.buffer, image), /TIFF (Deflate|PackBits)/)
    }
  }
})

test('last strips accept exactly remaining rows or complete padded strip storage', () => {
  for (const bits of [8, 16])
    for (const compression of [1, 5, 8, 32773])
      for (const padLastStrip of [false, true])
        check({ bits, compression, width: 5, height: 3, rowsPerStrip: 2, padLastStrip })
})

test('a valid compressed block whose byte count equals its decoded size is decompressed', () => {
  const data = new Uint8Array(16)
  let seed = 123
  for (let i = 0; i < 6; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    data[i] = seed >>> 24
  }
  assert.equal(deflateSync(data).length, data.length)
  check({ bits: 8, photo: 1, channels: 1, width: 16, height: 1, rowsPerStrip: 1, compression: 8, data })
})

test('unknown TIFF compression fails in the shared decoder and both codec operations', async () => {
  for (const littleEndian of [true, false])
    for (const tileSize of [0, 16]) {
      const { bytes } = makeTiffFixture({ littleEndian, tileSize }),
        view = new DataView(bytes.buffer)
      // Change the actual Compression SHORT in a complete, otherwise valid file.
      for (let i = 0; i < view.getUint16(8, littleEndian); i++) {
        const at = 10 + i * 12
        if (view.getUint16(at, littleEndian) === 259) view.setUint16(at + 8, 65000, littleEndian)
      }
      const original = bytes.slice(),
        image = UTIF.decode(bytes.buffer)[0]
      assert.equal(image.t259[0], 65000)
      assert.throws(() => UTIF.decodeImage(bytes.buffer, image), /Unsupported TIFF compression: 65000/)
      for (const operation of ['decode', 'decode-frame']) {
        await assert.rejects(
          processCodec({
            operation,
            format: 'image/tiff',
            file: new File([bytes], 'unknown.tif', { type: 'image/tiff' })
          }),
          (error) => error.code === 'CODEC_ERROR' && /Unsupported TIFF compression: 65000/.test(error.message)
        )
      }
      assert.deepEqual(bytes, original)
    }
})

test('UTIF regeneration applies only to the pinned source and marks local changes', async () => {
  const source = (
    await readFile(new URL('../node_modules/utif/UTIF.js', import.meta.url), 'utf8')
  ).replaceAll('\r\n', '\n')
  const patched = patchUtif(source)
  assert.match(patched, /^\/\/ OpenLR changes/)
  assert.throws(() => patchUtif(patched), /no longer matches/)
  const vendored = await readFile(new URL('../web/vendor/codecs/utif.js', import.meta.url), 'utf8')
  assert.ok(vendored.includes(patched))
})
