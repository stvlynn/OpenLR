import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng, makePngFixture, exifOrientation } from './fixtures/png.mjs'
import { deflateSync } from 'node:zlib'
import { makeColorProfile } from '../web/color-spaces.js'
import { makeGrayProfile, iccCurve } from './fixtures/icc-input.mjs'

const srgb = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
const near = (actual, expected, tolerance = 1e-7) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)
const p3 = { white: [0.3127, 0.329], red: [0.68, 0.32], green: [0.265, 0.69], blue: [0.15, 0.06] }

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  return page
}

test('PNG working input matches the native first APNG animation frame rather than its excluded default image', async (t) => {
  const page = await workspace(t),
    width = 2,
    height = 1,
    actl = new Uint8Array(8),
    fctl = new Uint8Array(26),
    control = new DataView(fctl.buffer),
    green = makePngFixture({
      width,
      height,
      bits: 16,
      colorType: 6,
      data: [0, 65535, 0, 65535, 0, 65535, 0, 65535]
    }),
    compressed = deflateSync(green.scanlines),
    fdat = new Uint8Array(4 + compressed.length)
  new DataView(actl.buffer).setUint32(0, 1)
  control.setUint32(4, width)
  control.setUint32(8, height)
  control.setUint16(20, 1)
  control.setUint16(22, 10)
  new DataView(fdat.buffer).setUint32(0, 1)
  fdat.set(compressed, 4)
  const bytes = makePng({
    width,
    height,
    bits: 16,
    colorType: 6,
    data: [65535, 0, 0, 65535, 65535, 0, 0, 65535],
    srgb: 0,
    beforeIdat: [['acTL', actl]],
    afterIdat: [
      ['fcTL', fctl],
      ['fdAT', fdat]
    ]
  })
  const result = await page.evaluate(async (bytes) => {
    const file = new File([new Uint8Array(bytes)], 'default-image.png', { type: 'image/png' }),
      { decodePhotoFrame } = await import('./decode.js'),
      frame = await decodePhotoFrame(file),
      bitmap = await createImageBitmap(file),
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
      ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    return {
      data: Array.from(frame.data),
      provenance: frame.provenance,
      native: Array.from(ctx.getImageData(0, 0, 2, 1).data),
      unchanged: Array.from(new Uint8Array(await file.arrayBuffer()))
    }
  }, Array.from(bytes))
  assert.deepEqual(result.native, [0, 255, 0, 255, 0, 255, 0, 255])
  assert.deepEqual(result.data, [0, 1, 0, 1, 0, 1, 0, 1])
  assert.equal(result.provenance.sourceBits, 16)
  assert.equal(result.provenance.animated, true)
  assert.equal(result.provenance.decodedFrame, 'animation-first')
  assert.deepEqual(result.unchanged, Array.from(bytes))
})

test('APNG first SOURCE/OVER frames retain 16-bit samples at their offset on a transparent canvas', async (t) => {
  const page = await workspace(t),
    fixtures = []
  for (const blend of [0, 1]) {
    const actl = new Uint8Array(8),
      fctl = new Uint8Array(26),
      control = new DataView(fctl.buffer),
      frame = makePngFixture({
        width: 2,
        height: 1,
        bits: 16,
        colorType: 6,
        data: [0, 65535, 0, 32768, 1, 2, 3, 65535]
      }),
      compressed = deflateSync(frame.scanlines),
      fdat = new Uint8Array(4 + compressed.length)
    new DataView(actl.buffer).setUint32(0, 1)
    control.setUint32(4, 2)
    control.setUint32(8, 1)
    control.setUint32(12, 1)
    control.setUint32(16, 1)
    control.setUint16(20, 1)
    control.setUint16(22, 10)
    control.setUint8(25, blend)
    new DataView(fdat.buffer).setUint32(0, 1)
    fdat.set(compressed, 4)
    fixtures.push(
      Array.from(
        makePng({
          width: 4,
          height: 3,
          bits: 16,
          colorType: 6,
          data: Array.from({ length: 48 }, (_, i) => (i % 4 === 0 || i % 4 === 3 ? 65535 : 0)),
          srgb: 0,
          beforeIdat: [['acTL', actl]],
          afterIdat: [
            ['fcTL', fctl],
            ['fdAT', fdat]
          ]
        })
      )
    )
  }
  const result = await page.evaluate(async (fixtures) => {
    const { decodePhotoFrame } = await import('./decode.js'),
      rows = []
    for (const bytes of fixtures) {
      const file = new File([new Uint8Array(bytes)], 'offset.png', { type: 'image/png' }),
        frame = await decodePhotoFrame(file),
        bitmap = await createImageBitmap(file),
        canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      rows.push({
        data: Array.from(frame.data),
        dimensions: [frame.width, frame.height],
        native: Array.from(ctx.getImageData(0, 0, 4, 3).data),
        provenance: frame.provenance
      })
    }
    return rows
  }, fixtures)
  for (const row of result) {
    assert.deepEqual(row.dimensions, [4, 3])
    const expected = Array(48).fill(0),
      native = Array(48).fill(0)
    expected.splice(20, 8, 0, 1, 0, 32768 / 65535, srgb(1 / 65535), srgb(2 / 65535), srgb(3 / 65535), 1)
    native.splice(20, 8, 0, 255, 0, 128, 0, 0, 0, 255)
    row.data.forEach((v, i) => near(v, expected[i]))
    assert.deepEqual(row.native, native)
    assert.equal(row.provenance.precision, 'uint16-source')
    assert.equal(row.provenance.animated, true)
    assert.equal(row.provenance.decodedFrame, 'animation-first')
  }
})

test('PNG working input retains 16-bit color/alpha and follows ICC,CICP,gamma/chromaticity interpretation', async (t) => {
  const page = await workspace(t),
    width = 128,
    height = 8,
    samples = Uint16Array.from({ length: width * height * 4 }, (_, i) =>
      i % 4 === 3 ? 65535 : 16384 + (Math.floor(i / 4) % width)
    ),
    make = (options) =>
      makePng({ width: 1, height: 1, bits: 16, colorType: 2, data: [65535, 0, 0], ...options }),
    inputs = {
      ramp: makePng({
        width,
        height,
        bits: 16,
        colorType: 6,
        data: samples,
        srgb: 0,
        filter: [0, 1, 2, 3, 4],
        interlace: 1,
        idatSize: 19
      }),
      icc: make({ profile: makeColorProfile('display-p3') }),
      cicp: make({ cicp: [12, 13, 0, 1] }),
      precedence: make({ cicp: [12, 13, 0, 1], profile: makeColorProfile('srgb') }),
      gammaChrm: make({ gamma: 0.45455, chromaticities: p3 }),
      gamma: make({ data: [32768, 32768, 32768], gamma: 0.5 }),
      untagged: make({ data: [32768, 32768, 32768] }),
      chrm: make({ chromaticities: p3 }),
      grayIcc: make({
        width: 3,
        colorType: 4,
        data: [32768, 65535, 32769, 1, 1, 0],
        profile: makeGrayProfile(iccCurve('curv', [512]))
      }),
      damagedPalette: make({
        width: 3,
        bits: 8,
        colorType: 3,
        data: [0, 1, 2],
        palette: [
          [255, 0, 0],
          [0, 255, 0]
        ],
        srgb: 0
      }),
      gray: make({ width: 2, colorType: 0, data: [256, 257], transparency: [256], srgb: 0 }),
      rgb: make({ width: 2, data: [256, 258, 260, 257, 258, 260], transparency: [256, 258, 260], srgb: 0 }),
      alpha: make({ width: 2, colorType: 6, data: [1, 2, 3, 1, 32768, 1024, 4096, 0], srgb: 0 }),
      compatibility: make({ cicp: [9, 16, 0, 1] }),
      invalidProfile: make({ profile: Uint8Array.of(1, 2, 3) })
    }
  const result = await page.evaluate(
    async (inputs) => {
      const { decodePhotoFrame, decodePhoto } = await import('./decode.js'),
        { getImageWorkerDiagnostics } = await import('./image-worker.js'),
        files = Object.fromEntries(
          Object.entries(inputs).map(([name, bytes]) => [
            name,
            new File([new Uint8Array(bytes)], name + '.png', { type: 'image/png' })
          ])
        ),
        frames = {}
      for (const name of Object.keys(inputs).filter((name) => name !== 'invalidProfile')) {
        const frame = await decodePhotoFrame(files[name])
        frames[name] = {
          data: Array.from(frame.data),
          width: frame.width,
          height: frame.height,
          colorSpace: frame.colorSpace,
          provenance: frame.provenance
        }
      }
      async function display(bitmap) {
        try {
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
            ctx = canvas.getContext('2d')
          ctx.drawImage(bitmap, 0, 0)
          return Array.from(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data)
        } finally {
          bitmap.close()
        }
      }
      const legacy = await display(await decodePhoto(files.ramp)),
        native = await display(await createImageBitmap(files.ramp)),
        before = getImageWorkerDiagnostics().length,
        failures = []
      const broken = new Uint8Array(inputs.ramp)
      broken[broken.length - 1] ^= 1
      for (const file of [new File([broken], 'bad-crc.png', { type: 'image/png' }), files.invalidProfile]) {
        try {
          await decodePhotoFrame(file)
          failures.push(null)
        } catch (error) {
          failures.push({ code: error.code, message: error.message })
        }
      }
      const after = getImageWorkerDiagnostics().length,
        recovered = await decodePhotoFrame(files.ramp),
        OriginalWorker = window.Worker
      let fallback
      try {
        window.Worker = class {
          constructor() {
            throw Error('Generated PNG startup failure')
          }
        }
        fallback = await decodePhotoFrame(files.ramp)
      } finally {
        window.Worker = OriginalWorker
      }
      const unchanged = []
      for (const [name, source] of Object.entries(inputs)) {
        const bytes = new Uint8Array(await files[name].arrayBuffer())
        unchanged.push(bytes.length === source.length && bytes.every((v, i) => v === source[i]))
      }
      return {
        frames,
        legacy,
        native,
        before,
        after,
        failures,
        recovered: Array.from(recovered.data),
        fallback: Array.from(fallback.data),
        fallbackProvenance: fallback.provenance,
        unchanged,
        diagnostics: getImageWorkerDiagnostics()
      }
    },
    Object.fromEntries(Object.entries(inputs).map(([name, bytes]) => [name, Array.from(bytes)]))
  )
  const ramp = result.frames.ramp
  assert.equal(ramp.colorSpace, 'srgb-linear')
  assert.equal(ramp.provenance.sourceBits, 16)
  assert.equal(ramp.provenance.precision, 'uint16-source')
  for (let i = 0; i < samples.length; i++) near(ramp.data[i], i % 4 === 3 ? 1 : srgb(samples[i] / 65535))
  assert.ok(
    ramp.data[0] < ramp.data[4] && ramp.data[4] < ramp.data[8],
    'within-byte source differences remain distinct'
  )
  for (const name of ['icc', 'cicp', 'precedence', 'gammaChrm', 'chrm']) {
    const frame = result.frames[name]
    near(frame.data[0], 1.224745, 0.0004)
    near(frame.data[1], -0.042058, 0.0004)
    near(frame.data[2], -0.019642, 0.0004)
    assert.equal(frame.provenance.precision, 'uint16-source')
  }
  assert.equal(result.frames.icc.provenance.colorTransform, 'icc-matrix-trc')
  assert.equal(result.frames.cicp.provenance.pngColorSource, 'cicp')
  assert.equal(result.frames.precedence.provenance.pngColorSource, 'cicp')
  assert.equal(result.frames.gammaChrm.provenance.colorTransform, 'png-gamma-chrm')
  near(result.frames.gamma.data[0], (32768 / 65535) ** 2)
  assert.deepEqual(result.frames.gamma.provenance.colorAssumptions, ['srgb-primaries'])
  near(result.frames.untagged.data[0], srgb(32768 / 65535))
  assert.equal(result.frames.untagged.provenance.pngColorSource, 'assumed-srgb')
  assert.deepEqual(result.frames.untagged.provenance.colorAssumptions, ['srgb'])
  assert.deepEqual(result.frames.chrm.provenance.colorAssumptions, ['srgb-transfer'])
  const grayIcc = result.frames.grayIcc
  assert.equal(grayIcc.provenance.colorTransform, 'icc-gray-trc')
  for (const [p, value] of [32768, 32769, 1].entries()) {
    for (let c = 0; c < 3; c++) near(grayIcc.data[p * 4 + c], (value / 65535) ** 2)
  }
  near(grayIcc.data[7], 1 / 65535)
  assert.equal(grayIcc.data[11], 0)
  assert.deepEqual(
    result.frames.gray.data.filter((_, i) => i % 4 === 3),
    [0, 1]
  )
  assert.deepEqual(
    result.frames.rgb.data.filter((_, i) => i % 4 === 3),
    [0, 1]
  )
  near(result.frames.gray.data[0], srgb(256 / 65535))
  near(result.frames.gray.data[4], srgb(257 / 65535))
  const alpha = result.frames.alpha.data
  assert.deepEqual(result.frames.damagedPalette.data, [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1])
  assert.ok(result.frames.damagedPalette.provenance.colorWarnings.includes('png-palette-index'))
  near(alpha[0], srgb(1 / 65535))
  near(alpha[1], srgb(2 / 65535))
  near(alpha[2], srgb(3 / 65535))
  near(alpha[3], 1 / 65535)
  near(alpha[4], srgb(32768 / 65535))
  assert.equal(alpha[7], 0)
  assert.equal(result.frames.compatibility.provenance.precision, 'rgba8-display')
  assert.equal(result.frames.compatibility.provenance.compatibilityReason, 'png-cicp')
  assert.equal(result.frames.compatibility.provenance.sourceBits, 16)
  assert.deepEqual(result.legacy, result.native, 'original PNG decode keeps the native path')
  assert.ok(result.failures.every((error) => error?.code === 'CODEC_ERROR'))
  assert.equal(result.before, result.after, 'decode failures do not trigger startup retry')
  assert.deepEqual(result.recovered, ramp.data)
  assert.deepEqual(result.fallback, ramp.data)
  assert.deepEqual(result.fallbackProvenance, ramp.provenance)
  assert.equal(result.diagnostics.at(-1).fallback, 'main-thread')
  assert.ok(result.unchanged.every(Boolean))
})

test('PNG display and working orientation agree in all 8 directions without reducing sample precision', async (t) => {
  const page = await workspace(t),
    values = [10001, 20002, 30003, 40004, 50005, 60006],
    fixtures = Array.from({ length: 8 }, (_, i) =>
      Array.from(
        makePng({
          width: 2,
          height: 3,
          bits: 16,
          colorType: 2,
          data: values.flatMap((v) => [v, v, v]),
          srgb: 0,
          exif: exifOrientation(i + 1)
        })
      )
    ),
    expected = [
      [0, 1, 2, 3, 4, 5],
      [1, 0, 3, 2, 5, 4],
      [5, 4, 3, 2, 1, 0],
      [4, 5, 2, 3, 0, 1],
      [0, 2, 4, 1, 3, 5],
      [4, 2, 0, 5, 3, 1],
      [5, 3, 1, 4, 2, 0],
      [1, 3, 5, 0, 2, 4]
    ]
  const result = await page.evaluate(async (fixtures) => {
    const { decodePhotoFrame, decodePhoto } = await import('./decode.js'),
      rows = []
    for (const bytes of fixtures) {
      const file = new File([new Uint8Array(bytes)], 'orientation.png', { type: 'image/png' }),
        frame = await decodePhotoFrame(file),
        native = await decodePhoto(file),
        canvas = new OffscreenCanvas(native.width, native.height),
        ctx = canvas.getContext('2d')
      ctx.drawImage(native, 0, 0)
      rows.push({
        width: frame.width,
        height: frame.height,
        data: Array.from(frame.data),
        provenance: frame.provenance,
        nativeWidth: native.width,
        nativeHeight: native.height,
        nativeRed: Array.from(ctx.getImageData(0, 0, native.width, native.height).data).filter(
          (_, i) => i % 4 === 0
        )
      })
      native.close()
    }
    return rows
  }, fixtures)
  for (const [index, row] of result.entries()) {
    assert.deepEqual([row.width, row.height], index >= 4 ? [3, 2] : [2, 3])
    assert.deepEqual([row.width, row.height], [row.nativeWidth, row.nativeHeight])
    assert.equal(row.provenance.sourceBits, 16)
    expected[index].forEach((source, p) => {
      near(row.data[p * 4], srgb(values[source] / 65535))
      assert.ok(Math.abs(row.nativeRed[p] - Math.round(values[source] / 257)) <= 1)
    })
  }
})

test('PNG display and compatibility decoding preserve CMS pixels while applying each EXIF orientation once', async (t) => {
  const page = await workspace(t),
    orders = [
      [0, 1, 2, 3, 4, 5],
      [1, 0, 3, 2, 5, 4],
      [5, 4, 3, 2, 1, 0],
      [4, 5, 2, 3, 0, 1],
      [0, 2, 4, 1, 3, 5],
      [4, 2, 0, 5, 3, 1],
      [5, 3, 1, 4, 2, 0],
      [1, 3, 5, 0, 2, 4]
    ],
    variants = [{ srgb: 0 }, { profile: makeColorProfile('display-p3') }, { cicp: [9, 16, 0, 1] }].map(
      (color) => {
        const options = {
          width: 2,
          height: 3,
          bits: 8,
          colorType: 6,
          data: [
            41, 68, 93, 255, 82, 110, 139, 255, 123, 154, 178, 255, 166, 193, 218, 255, 207, 162, 125, 255,
            242, 211, 182, 255
          ],
          ...color
        }
        return {
          plain: Array.from(makePng(options)),
          oriented: orders.map((_, i) => Array.from(makePng({ ...options, exif: exifOrientation(i + 1) })))
        }
      }
    )
  const results = await page.evaluate(async (variants) => {
    const { decodePhoto, decodePhotoFrame } = await import('./decode.js'),
      { processCodec } = await import('./codec-kernel.js'),
      capture = (bitmap) => {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        const result = {
          width: bitmap.width,
          height: bitmap.height,
          data: Array.from(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data)
        }
        bitmap.close()
        return result
      },
      output = []
    for (const [index, variant] of variants.entries()) {
      const base = capture(
          await createImageBitmap(new Blob([new Uint8Array(variant.plain)], { type: 'image/png' }))
        ),
        rows = []
      for (const bytes of variant.oriented) {
        const file = new File([new Uint8Array(bytes)], 'orientation.png', { type: 'image/png' }),
          display = capture(await decodePhoto(file)),
          direct = capture((await processCodec({ operation: 'decode', format: 'image/png', file })).bitmap),
          frame = index === 2 ? await decodePhotoFrame(file) : null
        rows.push({
          display,
          direct,
          frame: frame && {
            width: frame.width,
            height: frame.height,
            data: Array.from(frame.data),
            provenance: frame.provenance
          }
        })
        const after = Array.from(new Uint8Array(await file.arrayBuffer()))
        rows.at(-1).unchanged = after.length === bytes.length && after.every((v, i) => v === bytes[i])
      }
      output.push({ base, rows })
    }
    return output
  }, variants)
  for (const { base, rows } of results)
    for (const [index, row] of rows.entries()) {
      const expected = orders[index].flatMap((source) => base.data.slice(source * 4, source * 4 + 4))
      assert.deepEqual([row.display.width, row.display.height], index >= 4 ? [3, 2] : [2, 3])
      assert.deepEqual(row.display.data, expected)
      assert.deepEqual(row.direct, row.display)
      assert.equal(row.unchanged, true)
      if (row.frame) {
        assert.deepEqual([row.frame.width, row.frame.height], [row.display.width, row.display.height])
        assert.equal(row.frame.provenance.compatibilityReason, 'png-cicp')
        expected.forEach((v, i) => near(row.frame.data[i], i % 4 === 3 ? v / 255 : srgb(v / 255)))
      }
    }
})
