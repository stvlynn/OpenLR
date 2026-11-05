import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { readTiff, tiffEncodedPixels, orientTiffPixels } from '../web/tiff.js'
import { convertInputPixels } from '../web/input-color.js'
import { decodeSrgb, makeColorProfile } from '../web/color-spaces.js'
import { serveWorkspace } from './browser-server.mjs'
import { makeTiff, makeTiffFixture } from './fixtures/tiff.mjs'
import { iccCurve, rebuildIcc } from './fixtures/icc-input.mjs'

const close = (actual, expected, tolerance = 1e-7) =>
  actual.forEach((value, i) =>
    assert.ok(Math.abs(value - expected[i]) <= tolerance, `${actual} != ${expected}`)
  )

// Original TIFF fixture writer supplies the container; this helper repacks its
// rows into actual bilevel data and inserts FillOrder instead of SampleFormat.
function bilevelFixture({
  littleEndian = true,
  fillOrder = 2,
  photo = 1,
  compression = 1,
  compressed,
  bits = 1
} = {}) {
  const width = compressed ? 8 : 17,
    height = 2,
    rows = compressed ? 2 : 1,
    bytes = makeTiff({
      width,
      height,
      bits: 8,
      channels: 1,
      photo,
      littleEndian,
      rowsPerStrip: rows,
      data: Array(width * height).fill(0)
    }),
    view = new DataView(bytes.buffer),
    entries = [],
    values = Array.from({ length: width * height }, (_, i) =>
      [0, 9, 16, width + 2, width + 8].includes(i) ? 1 : 0
    )
  let offsets, counts
  for (let i = 0; i < view.getUint16(8, littleEndian); i++) {
    const at = 10 + i * 12,
      id = view.getUint16(at, littleEndian)
    if (id === 258) view.setUint16(at + 8, bits, littleEndian)
    if (id === 259) view.setUint16(at + 8, compression, littleEndian)
    if (id === 339) {
      view.setUint16(at, 266, littleEndian)
      view.setUint16(at + 8, fillOrder, littleEndian)
    }
    if (id === 273 || id === 279) {
      const count = view.getUint32(at + 4, littleEndian),
        location = count === 1 ? at + 8 : view.getUint32(at + 8, littleEndian),
        locations = Array.from({ length: count }, (_, n) => location + n * 4)
      if (id === 273) offsets = locations.map((a) => view.getUint32(a, littleEndian))
      else counts = locations
    }
    entries.push(bytes.slice(at, at + 12))
  }
  const rowBytes = Math.ceil(width / 8)
  if (compressed) {
    bytes.set(compressed, offsets[0])
    view.setUint32(counts[0], compressed.length, littleEndian)
  } else
    for (let y = 0; y < height; y++) {
      view.setUint32(counts[y], rowBytes, littleEndian)
      for (let x = 0; x < width; x++)
        if (values[y * width + x])
          bytes[offsets[y] + (x >> 3)] |= 1 << (fillOrder === 2 ? x % 8 : 7 - (x % 8))
    }
  // Preserve the TIFF requirement that directory entries are sorted by tag.
  entries.sort(
    (a, b) =>
      new DataView(a.buffer).getUint16(0, littleEndian) - new DataView(b.buffer).getUint16(0, littleEndian)
  )
  // Strip count fields are inline for CCITT but in external arrays for two rows.
  for (const entry of entries)
    if (new DataView(entry.buffer).getUint16(0, littleEndian) === 279 && compressed)
      new DataView(entry.buffer).setUint32(8, compressed.length, littleEndian)
  entries.forEach((entry, i) => bytes.set(entry, 10 + i * 12))
  return { bytes, values }
}

test('full TIFF decoding normalizes uncompressed bilevel FillOrder2 in both byte orders without changing originals', () => {
  for (const littleEndian of [true, false])
    for (const photo of [0, 1])
      for (const fillOrder of [1, 2]) {
        const { bytes, values } = bilevelFixture({ littleEndian, photo, fillOrder }),
          original = bytes.slice(),
          image = readTiff(bytes.buffer),
          pixels = tiffEncodedPixels(image)
        assert.deepEqual(Array.from(image.data), [128, 64, 128, 32, 128, 0])
        assert.deepEqual(
          Array.from(pixels.data.filter((_, i) => i % 4 === 0)),
          values.map((value) => (photo === 0 ? 1 - value : value))
        )
        assert.deepEqual(bytes, original)
      }
})

test('CCITT3/4 FillOrder2 remains normalized once and ambiguous or invalid orderings reject', () => {
  // Pillow 12/libtiff generated these seven-byte streams from an original 8x2
  // mode-1 image with input bytes [0x80,0x20], with tags 266=1/2. No photo asset.
  const streams = [
    [3, 1, '001355e002eb00'],
    [3, 2, '00c8aa0740d700'],
    [4, 1, '26aa2475001001'],
    [4, 2, '645524ae000880']
  ]
  for (const [compression, fillOrder, hex] of streams) {
    const { bytes } = bilevelFixture({
        compression,
        fillOrder,
        compressed: Uint8Array.from(Buffer.from(hex, 'hex'))
      }),
      image = readTiff(bytes.buffer)
    assert.deepEqual(
      Array.from(image.data),
      [128, 32],
      `${compression}/${fillOrder} must not be reversed twice`
    )
  }
  for (const fillOrder of [0, 3])
    assert.throws(() => readTiff(bilevelFixture({ fillOrder }).bytes.buffer), /fill order/)
  for (const compression of [5, 8, 32773])
    assert.throws(() => readTiff(bilevelFixture({ compression }).bytes.buffer), /fill order/)
  for (const bits of [2, 4, 8, 16])
    assert.throws(() => readTiff(bilevelFixture({ bits }).bytes.buffer), /fill order/)
})

test('unsupported predictors fail before ignored or byte-wise reconstruction can corrupt samples', () => {
  for (const predictor of [0, 3, 999])
    assert.throws(() => readTiff(makeTiff({ predictor }).buffer), /Unsupported TIFF predictor/)
  const { bytes } = bilevelFixture({ fillOrder: 1 }),
    view = new DataView(bytes.buffer)
  for (let i = 0; i < view.getUint16(8, true); i++) {
    const at = 10 + i * 12
    if (view.getUint16(at, true) === 317) view.setUint16(at + 8, 2, true)
  }
  assert.throws(() => readTiff(bytes.buffer), /Unsupported TIFF predictor/)
})

test('TIFF normalized samples retain actual source words across endian, strip/tile and RGB/gray layouts', () => {
  for (const bits of [8, 16])
    for (const littleEndian of [true, false])
      for (const tileSize of [0, 16])
        for (const [photo, channels] of [
          [2, 3],
          [2, 4],
          [0, 1],
          [1, 1],
          [1, 2]
        ]) {
          const options = {
              bits,
              littleEndian,
              tileSize,
              photo,
              channels,
              alpha: [2, 4].includes(channels) ? 2 : 0
            },
            { bytes, samples } = makeTiffFixture(options),
            original = bytes.slice(),
            image = readTiff(bytes.buffer),
            encoded = tiffEncodedPixels(image),
            maximum = 2 ** bits - 1
          assert.equal(encoded.sourceBits, bits)
          assert.deepEqual([encoded.width, encoded.height], [5, 4])
          for (let i = 0; i < 20; i++) {
            const expected = [0, 1, 2].map((channel) => {
              const value = samples[i * channels + (photo === 2 ? channel : 0)] / maximum
              return photo === 0 ? 1 - value : value
            })
            expected.push(options.alpha ? samples[(i + 1) * channels - 1] / maximum : 1)
            close(encoded.data.subarray(i * 4, i * 4 + 4), expected)
          }
          assert.deepEqual(bytes, original)
        }
})

test('associated alpha is undone before color conversion and unassociated hidden RGB survives', () => {
  for (const [photo, channels] of [
    [2, 4],
    [1, 2]
  ]) {
    const data = channels === 4 ? [123, 456, 789, 32768, 700, 800, 900, 0] : [123, 32768, 700, 0],
      associated = tiffEncodedPixels(
        readTiff(makeTiff({ width: 2, height: 1, photo, channels, data, alpha: 1 }).buffer)
      ),
      straight = tiffEncodedPixels(
        readTiff(makeTiff({ width: 2, height: 1, photo, channels, data, alpha: 2 }).buffer)
      )
    close(associated.data.subarray(0, 4), [
      123 / 32768,
      (channels === 4 ? 456 : 123) / 32768,
      (channels === 4 ? 789 : 123) / 32768,
      32768 / 65535
    ])
    close(associated.data.subarray(4), [0, 0, 0, 0])
    assert.equal(straight.data[7], 0)
    assert.ok(straight.data[4] > 0, 'straight hidden RGB must not be erased')
  }
})

test('palette RGB retains 16-bit color-map low bits and packed grayscale rows decode at their source depth', () => {
  const map = Array(768).fill(0)
  for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) map[c * 256 + i] = (i * 149 + c * 257 + 1) % 65536
  const encoded = tiffEncodedPixels(
    readTiff(
      makeTiff({ width: 3, height: 1, bits: 8, photo: 3, channels: 1, data: [0, 1, 255], colorMap: map })
        .buffer
    )
  )
  assert.equal(encoded.sourceBits, 16)
  close(encoded.data.subarray(0, 4), [map[0] / 65535, map[256] / 65535, map[512] / 65535, 1])
  assert.ok(encoded.data[0] > 0 && encoded.data[0] < 1 / 255)
  for (const bits of [1, 2, 4]) {
    const width = 5,
      height = 2,
      maximum = 2 ** bits - 1,
      rowBytes = Math.ceil((width * bits) / 8),
      values = Array.from({ length: width * height }, (_, i) => i % (maximum + 1)),
      data = new Uint8Array(rowBytes * height)
    values.forEach((value, i) => {
      const x = i % width,
        y = Math.floor(i / width),
        bit = x * bits
      data[y * rowBytes + (bit >> 3)] |= value << (8 - bits - (bit % 8))
    })
    const pixels = tiffEncodedPixels({ width, height, t258: [bits], t262: [1], t277: [1], data })
    assert.equal(pixels.sourceBits, bits)
    values.forEach((value, i) =>
      close(pixels.data.subarray(i * 4, i * 4 + 4), [value / maximum, value / maximum, value / maximum, 1])
    )
  }
})

test('all eight TIFF orientations move complete float pixels without altering their values', () => {
  const pixels = {
      width: 3,
      height: 2,
      data: Float32Array.from(
        Array.from({ length: 6 }, (_, i) => [i + 1, -0.1 * i, 1 + i / 10, i / 7]).flat()
      ),
      sourceBits: 16
    },
    original = pixels.data.slice(),
    expected = [
      [1, 2, 3, 4, 5, 6],
      [3, 2, 1, 6, 5, 4],
      [6, 5, 4, 3, 2, 1],
      [4, 5, 6, 1, 2, 3],
      [1, 4, 2, 5, 3, 6],
      [4, 1, 5, 2, 6, 3],
      [6, 3, 5, 2, 4, 1],
      [3, 6, 2, 5, 1, 4]
    ]
  for (let orientation = 1; orientation <= 8; orientation++) {
    const output = orientTiffPixels(pixels, orientation)
    assert.deepEqual([output.width, output.height], orientation >= 5 ? [2, 3] : [3, 2])
    assert.equal(output.sourceBits, 16)
    assert.deepEqual(Array.from(output.data.filter((_, i) => i % 4 === 0)), expected[orientation - 1])
    expected[orientation - 1].forEach((id, i) =>
      assert.deepEqual(output.data.subarray(i * 4, i * 4 + 4), original.subarray((id - 1) * 4, id * 4))
    )
  }
  assert.deepEqual(pixels.data, original)
})

test('TIFF input conversion preserves distinct sub-byte levels and signed wide-profile colors', () => {
  const bytes = makeTiff({
      width: 512,
      height: 1,
      data: Array.from({ length: 512 }, (_, i) => [1000 + i, 1000 + i, 1000 + i]).flat()
    }),
    original = bytes.slice(),
    pixels = tiffEncodedPixels(readTiff(bytes.buffer)),
    { frame } = convertInputPixels(pixels)
  assert.equal(new Set(frame.data.filter((_, i) => i % 4 === 0)).size, 512)
  close(frame.data.subarray(0, 3), Array(3).fill(decodeSrgb(Math.fround(1000 / 65535))), 1e-10)
  const wide = tiffEncodedPixels(readTiff(makeTiff({ width: 1, height: 1, data: [65535, 0, 0] }).buffer)),
    transformed = convertInputPixels(wide, { profile: makeColorProfile('display-p3') }).frame
  assert.ok(transformed.data[0] > 1.2 && transformed.data[1] < -0.04 && transformed.data[2] < -0.01)
  assert.equal(transformed.provenance.colorTransform, 'icc-matrix-trc')
  assert.deepEqual(bytes, original)
})

test('real browser TIFF decode-frame preserves 16-bit words, shares worker/fallback and reports honest compatibility', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  // ICC v4 permits an AToB B-curves-only mAB pipeline. It is intentionally
  // outside our matrix/TRC interpreter, despite also retaining matrix tags.
  const lut = new Uint8Array(68),
    lv = new DataView(lut.buffer)
  lut.set(new TextEncoder().encode('mAB '))
  lut[8] = lut[9] = 3
  lv.setUint32(12, 32)
  for (let i = 0; i < 3; i++) lut.set(iccCurve('curv'), 32 + i * 12)
  const compatibilityProfile = rebuildIcc({ A2B0: lut }),
    fixtures = {
      ramp: makeTiff({
        width: 512,
        height: 2,
        data: Array.from({ length: 1024 }, (_, i) => [
          1000 + (i % 512),
          2000 + (i % 512),
          3000 + (i % 512)
        ]).flat(),
        littleEndian: false,
        tileSize: 16,
        compression: 8,
        predictor: 2
      }),
      wide: makeTiff({
        width: 2,
        height: 1,
        channels: 4,
        alpha: 2,
        data: [65535, 0, 0, 32769, 1, 2, 3, 0],
        profile: makeColorProfile('display-p3'),
        orientation: 6
      }),
      compatibility: makeTiff({
        width: 2,
        height: 1,
        data: [10000, 20000, 30000, 40000, 50000, 60000],
        profile: compatibilityProfile
      }),
      malformed: makeTiff({ width: 1, height: 1, data: [1, 2, 3], profile: new Uint8Array([1, 2, 3]) })
    }
  const result = await page.evaluate(
    async (fixtures) => {
      const { decodePhotoFrame, decodePhoto } = await import('./decode.js'),
        { processCodec } = await import('./codec-kernel.js')
      const file = (id) => new File([Uint8Array.from(fixtures[id])], `${id}.tif`, { type: 'image/tiff' })
      const rampFile = file('ramp'),
        original = Array.from(new Uint8Array(await rampFile.arrayBuffer())),
        frame = await decodePhotoFrame(rampFile),
        wide = await decodePhotoFrame(file('wide')),
        compat = await decodePhotoFrame(file('compatibility'))
      const nativeWorker = window.Worker
      let fallback, noBridge
      try {
        window.Worker = class {
          constructor() {
            throw Error('Forced TIFF worker startup failure')
          }
        }
        fallback = await decodePhotoFrame(rampFile)
        const bitmap = window.createImageBitmap
        try {
          window.createImageBitmap = () => {
            throw Error('High-depth decode crossed an 8-bit image bridge')
          }
          noBridge = (await processCodec({ operation: 'decode-frame', format: 'image/tiff', file: rampFile }))
            .frame
        } finally {
          window.createImageBitmap = bitmap
        }
      } finally {
        window.Worker = nativeWorker
      }
      const bad = []
      for (const input of [
        file('malformed'),
        new File(['invalid'], 'bad.tif', { type: 'image/tiff' }),
        new File([Uint8Array.from(fixtures.ramp).slice(0, -10)], 'truncated.tif', { type: 'image/tiff' })
      ]) {
        try {
          await decodePhotoFrame(input)
          bad.push(null)
        } catch (error) {
          bad.push({ code: error.code, message: error.message })
        }
      }
      const bitmap = await decodePhoto(rampFile),
        canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d').drawImage(bitmap, 0, 0)
      bitmap.close()
      const legacy = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      return {
        ramp: {
          width: frame.width,
          height: frame.height,
          provenance: frame.provenance,
          first: Array.from(frame.data.slice(0, 4)),
          distinct: new Set(frame.data.filter((_, i) => i % 4 === 0)).size
        },
        sameFallback: frame.data.every((v, i) => v === fallback.data[i]),
        noBridge: frame.data.every((v, i) => v === noBridge.data[i]),
        wide: {
          width: wide.width,
          height: wide.height,
          data: Array.from(wide.data),
          provenance: wide.provenance
        },
        compatibility: compat.provenance,
        bad,
        legacyFirst: Array.from(legacy.slice(0, 4)),
        immutable:
          JSON.stringify(original) ===
          JSON.stringify(Array.from(new Uint8Array(await rampFile.arrayBuffer())))
      }
    },
    Object.fromEntries(Object.entries(fixtures).map(([id, bytes]) => [id, Array.from(bytes)]))
  )
  assert.deepEqual([result.ramp.width, result.ramp.height], [512, 2])
  assert.equal(result.ramp.distinct, 512)
  assert.equal(result.ramp.provenance.sourceBits, 16)
  assert.equal(result.ramp.provenance.precision, 'uint16-source')
  close(result.ramp.first, [1000, 2000, 3000].map((v) => decodeSrgb(Math.fround(v / 65535))).concat(1), 1e-9)
  assert.equal(result.sameFallback, true)
  assert.equal(result.noBridge, true)
  assert.equal(result.immutable, true)
  assert.deepEqual([result.wide.width, result.wide.height], [1, 2])
  assert.ok(result.wide.data[0] > 1.2 && result.wide.data[1] < 0)
  assert.equal(result.wide.data[3], Math.fround(32769 / 65535))
  assert.equal(result.wide.data[7], 0)
  assert.equal(result.compatibility.precision, 'rgba8-display')
  assert.equal(result.compatibility.compatibilityReason, 'profile-lut')
  assert.ok(result.bad.every((error) => error?.code === 'CODEC_ERROR'))
  assert.deepEqual(result.legacyFirst, [3, 7, 11, 255], 'legacy import keeps its captured high-byte policy')
})
