import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makeColorProfile, decodeSrgb } from '../web/color-spaces.js'
import { jxlInputCases } from './fixtures/jxl-input.mjs'

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  return page
}

async function legacyFixtures() {
  // The installed published package is a validation reference, never runtime.
  // Its C++ result constructor needs this display-value holder in Node only.
  globalThis.ImageData ??= class ImageData {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height })
    }
  }
  const oldUrl = new URL('../node_modules/@jsquash/jxl/codec/dec/jxl_dec.js', import.meta.url),
    { default: oldFactory } = await import(oldUrl),
    old = await oldFactory({ wasmBinary: await readFile(new URL('jxl_dec.wasm', oldUrl)) }),
    newUrl = new URL('../web/vendor/codecs/jxl/codec/enc/jxl_color_enc.js', import.meta.url),
    { default: encoderFactory } = await import(newUrl),
    encoder = await encoderFactory({ wasmBinary: await readFile(new URL('jxl_color_enc.wasm', newUrl)) }),
    width = 17,
    height = 9,
    samples = Uint8Array.from(
      { length: width * height * 4 },
      (_, i) => (i * 37 + Math.floor(i / 4) * 11) & 255
    ),
    fixtures = []
  samples.set([70, 80, 90, 0, 180, 60, 40, 128, 255, 0, 0, 255])
  for (const space of ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020'])
    for (const quality of [100, 80]) {
      const bytes = encoder.encodeColor(
        samples,
        width,
        height,
        makeColorProfile(space),
        quality,
        quality === 100,
        7,
        space === 'srgb'
      )
      assert.ok(bytes?.length)
      const expected = old.decode(bytes)
      assert.ok(expected)
      fixtures.push({
        space,
        quality,
        bytes: Array.from(bytes),
        expected: Array.from(expected.data),
        width,
        height
      })
    }
  // Include real high-depth/float, associated-alpha and animation files too:
  // working precision changes must not silently rewrite Original processing.
  for (const name of [...Object.keys(jxlInputCases()), 'animation-first']) {
    const bytes = new Uint8Array(await readFile(new URL(`./fixtures/jxl/${name}.jxl`, import.meta.url))),
      expected = old.decode(bytes)
    assert.ok(expected, 'published fixture decode: ' + name)
    fixtures.push({
      space: name,
      quality: 'fixture',
      bytes: Array.from(bytes),
      expected: Array.from(expected.data),
      width: expected.width,
      height: expected.height
    })
  }
  return fixtures
}

test('rebuilt JPEG XL display decoder preserves every published byte across all five profiles and lossy/lossless files', async (t) => {
  const page = await workspace(t),
    fixtures = await legacyFixtures()
  const decoded = await page.evaluate(async (fixtures) => {
    const { decodeJxl } = await import('./color-codecs.js'),
      result = []
    for (const fixture of fixtures) {
      const pixels = await decodeJxl(Uint8Array.from(fixture.bytes).buffer)
      result.push({ width: pixels.width, height: pixels.height, data: Array.from(pixels.data) })
    }
    return result
  }, fixtures)
  for (let i = 0; i < fixtures.length; i++) {
    assert.deepEqual([decoded[i].width, decoded[i].height], [fixtures[i].width, fixtures[i].height])
    assert.deepEqual(decoded[i].data, fixtures[i].expected, `${fixtures[i].space}/${fixtures[i].quality}`)
  }
})

async function inputFixtures() {
  const cases = jxlInputCases(),
    entries = []
  for (const [name, source] of Object.entries(cases)) {
    const bytes = await readFile(new URL(`./fixtures/jxl/${name}.jxl`, import.meta.url))
    entries.push([name, { bytes: Array.from(bytes), source }])
  }
  entries.push([
    'animation-first',
    {
      bytes: Array.from(await readFile(new URL('./fixtures/jxl/animation-first.jxl', import.meta.url))),
      source: null
    }
  ])
  return Object.fromEntries(entries)
}

test('JPEG XL working frames retain source precision, signed wide color, alpha, orientation and first-frame semantics', async (t) => {
  const page = await workspace(t),
    fixtures = await inputFixtures(),
    reference = JSON.parse(await readFile(new URL('./fixtures/jxl/metadata.json', import.meta.url), 'utf8'))
  const frames = await page.evaluate(
    async (inputs) => {
      const { decodePhotoFrame } = await import('./decode.js'),
        results = {}
      for (const [name, bytes] of Object.entries(inputs)) {
        const frame = await decodePhotoFrame(
          new File([Uint8Array.from(bytes)], name + '.jxl', { type: 'image/jxl' })
        )
        results[name] = {
          width: frame.width,
          height: frame.height,
          data: Array.from(frame.data),
          provenance: frame.provenance,
          colorSpace: frame.colorSpace
        }
      }
      return results
    },
    Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, fixture.bytes]))
  )
  for (const name of [
    'srgb16',
    'p3-16',
    'gray16',
    'linear-float',
    'p3-float',
    'xyb-float',
    'lut16',
    'lut-b-only16',
    'lut-b-gamma16',
    'lut-matrix-gamma16',
    'lut-a2b1-16',
    'lut-priority16',
    'lut-mft2-16',
    'straight16',
    'premul16',
    'orientation6'
  ]) {
    const frame = frames[name],
      source = fixtures[name].source
    assert.equal(frame.colorSpace, 'srgb-linear')
    assert.equal(frame.provenance.sourceBits, source.bits)
    assert.equal(frame.provenance.sourceExponentBits, source.exponentBits)
    assert.equal(frame.provenance.outputBits, 32)
    assert.equal(frame.provenance.precision, source.exponentBits ? 'float-source' : 'integer-source')
    assert.equal(frame.provenance.colorTransform, 'skcms-linear-srgb')
    assert.ok(frame.data.every(Number.isFinite))
    assert.equal('dataICC' in frame.provenance, false)
    assert.equal('originalICC' in frame.provenance, false)
  }
  const source = fixtures.srgb16.source,
    srgb = frames.srgb16
  assert.deepEqual([srgb.width, srgb.height], [source.width, source.height])
  let maximumError = 0
  for (let i = 0; i < source.data.length; i++)
    maximumError = Math.max(
      maximumError,
      Math.abs(srgb.data[i] - (i % 4 === 3 ? source.data[i] / 65535 : decodeSrgb(source.data[i] / 65535)))
    )
  assert.ok(maximumError < 2e-6, `sRGB source error ${maximumError}`)
  assert.equal(new Set(srgb.data.filter((_, i) => i % 4 === 0)).size, 512)
  assert.ok(
    frames['p3-16'].data[0] > 1.2 && frames['p3-16'].data[1] < -0.04,
    'P3 red must remain outside display sRGB'
  )
  assert.ok(frames['p3-16'].data[2] < -0.019)
  const gray = fixtures.gray16.source
  for (let i = 0; i < gray.width; i++) {
    const expected = (gray.data[i * 2] / 65535) ** (563 / 256)
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(frames.gray16.data[i * 4 + c] - expected) < 2e-6)
  }
  for (const name of ['linear-float', 'p3-float', 'xyb-float']) {
    assert.ok(
      frames[name].data.some((v, i) => i % 4 !== 3 && v < 0),
      name + ' negative color'
    )
    assert.ok(
      frames[name].data.some((v, i) => i % 4 !== 3 && v > 1),
      name + ' highlight'
    )
  }
  // FLOAT storage preserves source values, but DATA ICC still transforms into
  // skcms's linear-sRGB definition. Independent LCMS measured 4.10e-4 maximum
  // signed/HDR difference; this is not an identity color transform assertion.
  const linearReference = reference.independentCms.metrics['linear-float'].firstReference
  for (let pixel = 0; pixel < 3; pixel++)
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs(frames['linear-float'].data[pixel * 4 + c] - linearReference[pixel * 3 + c]) < 5e-4)
  for (const name of Object.keys(fixtures).filter(
    (name) => name.startsWith('lut') && name !== 'lut-mft1-16'
  )) {
    const expected = reference.independentCms.metrics[name].firstReference
    assert.equal(frames[name].provenance.profileTransform, 'lut')
    assert.equal(frames[name].provenance.profileCorrection, 'xyz-lut-output-scale')
    for (let pixel = 0; pixel < 3; pixel++)
      for (let c = 0; c < 3; c++)
        assert.ok(
          Math.abs(frames[name].data[pixel * 4 + c] - expected[pixel * 3 + c]) < 5e-4,
          `${name}: actual PCS normalization`
        )
    assert.equal(frames[name].data[3], 1, 'PCS normalization must not scale alpha')
  }
  const straight = frames.straight16.data
  assert.ok(Math.abs(straight[3] - 32769 / 65535) < 1e-7)
  assert.equal(straight[7], 0)
  assert.ok(straight[4] > 0)
  assert.ok(Math.abs(straight[11] - 1 / 65535) < 1e-9)
  assert.equal(frames.premul16.provenance.sourceAlphaPremultiplied, true)
  for (let c = 0; c < 3; c++)
    assert.ok(
      Math.abs(frames.premul16.data[c] - decodeSrgb([0.25, 0.125, 0.0625][c])) < 1e-4,
      'working alpha must be undone only once'
    )
  assert.equal(frames.premul16.data[7], 0)
  assert.ok(frames.premul16.data[8] > 0.999)
  const oriented = frames.orientation6,
    original = fixtures.orientation6.source
  assert.deepEqual([oriented.width, oriented.height], [2, 3])
  const order = [3, 0, 4, 1, 5, 2]
  for (let p = 0; p < order.length; p++)
    for (let c = 0; c < 3; c++)
      assert.ok(
        Math.abs(oriented.data[p * 4 + c] - decodeSrgb(original.data[order[p] * 4 + c] / 65535)) < 1e-4
      )
  for (const name of ['pq16', 'hlg16', 'table-float', 'lut-mft1-16']) {
    assert.equal(frames[name].provenance.precision, 'rgba8-display')
    assert.ok(
      ['jxl-hdr-transfer', 'jxl-profile-range', 'jxl-profile-unsupported'].includes(
        frames[name].provenance.compatibilityReason
      )
    )
    assert.equal(frames[name].provenance.sourceBits, fixtures[name].source.bits)
  }
  const first = frames['animation-first']
  assert.equal(first.provenance.animated, true)
  assert.equal(first.provenance.decodedFrame, 'first')
  assert.deepEqual([first.width, first.height], [2, 1])
  for (let i = 0; i < first.data.length; i++)
    assert.ok(
      Math.abs(first.data[i] - [1, 0, 0, 1][i % 4]) < 2e-4,
      'first displayed frame must remain red rather than later green'
    )
})

test('JPEG XL worker startup fallback shares float results while corrupt processing errors do not retry', async (t) => {
  const page = await workspace(t),
    fixture = (await inputFixtures()).srgb16
  const result = await page.evaluate(async (input) => {
    const { decodePhotoFrame } = await import('./decode.js'),
      { processCodec } = await import('./codec-kernel.js'),
      { getImageWorkerDiagnostics } = await import('./image-worker.js')
    const file = new File([Uint8Array.from(input)], 'source16.jxl', { type: 'image/jxl' }),
      normal = await decodePhotoFrame(file),
      before = getImageWorkerDiagnostics().length,
      failures = []
    for (const bytes of [
      Uint8Array.of(255, 10),
      Uint8Array.from(input).slice(0, Math.floor(input.length / 2))
    ]) {
      try {
        await decodePhotoFrame(new File([bytes], 'broken.jxl', { type: 'image/jxl' }))
        failures.push(null)
      } catch (error) {
        failures.push({ code: error.code, message: error.message })
      }
    }
    const afterFailures = getImageWorkerDiagnostics().length,
      recovered = await decodePhotoFrame(file),
      OriginalWorker = window.Worker,
      OriginalBitmap = window.createImageBitmap
    let fallback, direct
    try {
      window.Worker = class {
        constructor() {
          throw Error('Forced JPEG XL startup failure')
        }
      }
      fallback = await decodePhotoFrame(file)
      window.createImageBitmap = () => {
        throw Error('Working decode crossed byte bitmap boundary')
      }
      direct = (await processCodec({ operation: 'decode-frame', format: 'image/jxl', file })).frame
    } finally {
      window.Worker = OriginalWorker
      window.createImageBitmap = OriginalBitmap
    }
    return {
      normal: Array.from(normal.data),
      recovered: Array.from(recovered.data),
      fallback: Array.from(fallback.data),
      direct: Array.from(direct.data),
      provenance: normal.provenance,
      fallbackProvenance: fallback.provenance,
      before,
      afterFailures,
      failures,
      diagnostics: getImageWorkerDiagnostics(),
      original: Array.from(new Uint8Array(await file.arrayBuffer()))
    }
  }, fixture.bytes)
  assert.deepEqual(result.recovered, result.normal)
  assert.deepEqual(result.fallback, result.normal)
  assert.deepEqual(result.direct, result.normal)
  assert.deepEqual(result.fallbackProvenance, result.provenance)
  assert.equal(result.afterFailures, result.before)
  assert.ok(result.failures.every((error) => error?.code === 'CODEC_ERROR'))
  assert.equal(result.diagnostics.at(-1).fallback, 'main-thread')
  assert.deepEqual(result.original, fixture.bytes)
})
