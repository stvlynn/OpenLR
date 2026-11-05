import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { defaultOptions } from '../web/vendor/codecs/avif/meta.js'
import { makeColorProfile, decodeSrgb } from '../web/color-spaces.js'
import UTIF from '../web/vendor/codecs/utif.js'

async function fixtures() {
  const url = new URL('../web/vendor/codecs/avif/codec/enc/avif_enc.js', import.meta.url),
    { default: factory } = await import(url),
    encoder = await factory({ wasmBinary: await readFile(new URL('avif_enc.wasm', url)) }),
    width = 128,
    height = 8
  const encode = (depth, { wide = false, icc = new Uint8Array(), cp = 1, tc = 13 } = {}) => {
    const max = 2 ** depth - 1,
      data = new Uint16Array(width * height * 4)
    for (let p = 0; p < width * height; p++) {
      const value = Math.floor(max / 4) + (p % width)
      data.set(wide ? [max, 0, 0, max] : [value, value, value, max], p * 4)
    }
    if (!wide) {
      data.set([1, 2, 3, 1], 0)
      data[7] = 0
    }
    const bytes = encoder.encode(new Uint8Array(data.buffer), width, height, {
      ...defaultOptions,
      quality: 100,
      subsample: 3,
      speed: 10,
      bitDepth: depth,
      icc,
      colorPrimaries: cp,
      transferCharacteristics: tc,
      matrixCoefficients: 0,
      fullRange: true
    })
    assert.ok(bytes?.length)
    return { bytes, data, width, height, depth }
  }
  return {
    ten: encode(10),
    twelve: encode(12),
    iccWide: encode(12, { wide: true, icc: makeColorProfile('display-p3'), cp: 2, tc: 2 }),
    cicpWide: encode(12, { wide: true, cp: 12 }),
    hdr: encode(10, { cp: 9, tc: 16 }),
    invalidProfile: encode(12, { icc: Uint8Array.of(1, 2, 3) })
  }
}

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  return {
    page,
    run: (command, args = {}) =>
      page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args])
  }
}

test('AVIF working decode preserves high-depth samples, wide color, alpha, originals and worker failure boundaries', async (t) => {
  const { page } = await workspace(t),
    generated = await fixtures()
  const input = Object.fromEntries(
    Object.entries(generated).map(([name, fixture]) => [name, Array.from(fixture.bytes)])
  )
  const result = await page.evaluate(async (inputs) => {
    const { decodePhotoFrame } = await import('./decode.js'),
      { getImageWorkerDiagnostics } = await import('./image-worker.js'),
      files = Object.fromEntries(
        Object.entries(inputs).map(([key, bytes]) => [
          key,
          new File([new Uint8Array(bytes)], key + '.avif', { type: 'image/avif' })
        ])
      ),
      frames = {}
    for (const name of ['ten', 'twelve', 'iccWide', 'cicpWide', 'hdr']) {
      const frame = await decodePhotoFrame(files[name])
      frames[name] = {
        data: Array.from(frame.data),
        width: frame.width,
        height: frame.height,
        colorSpace: frame.colorSpace,
        provenance: frame.provenance
      }
    }
    const diagnosticsBefore = getImageWorkerDiagnostics().length,
      failures = []
    for (const file of [
      new File([Uint8Array.of(1, 2, 3)], 'broken.avif', { type: 'image/avif' }),
      files.invalidProfile
    ]) {
      try {
        await decodePhotoFrame(file)
        failures.push(null)
      } catch (error) {
        failures.push({ code: error.code, message: error.message })
      }
    }
    const diagnosticsAfterFailures = getImageWorkerDiagnostics().length,
      recovered = await decodePhotoFrame(files.twelve),
      OriginalWorker = window.Worker
    let fallback
    try {
      window.Worker = class {
        constructor() {
          throw Error('Generated worker-startup test failure')
        }
      }
      fallback = await decodePhotoFrame(files.twelve)
    } finally {
      window.Worker = OriginalWorker
    }
    const sourceSame = []
    for (const name of Object.keys(inputs)) {
      const bytes = new Uint8Array(await files[name].arrayBuffer())
      sourceSame.push(bytes.length === inputs[name].length && bytes.every((v, i) => v === inputs[name][i]))
    }
    return {
      frames,
      failures,
      diagnosticsBefore,
      diagnosticsAfterFailures,
      sourceSame,
      recovered: Array.from(recovered.data),
      fallback: Array.from(fallback.data),
      fallbackProvenance: fallback.provenance,
      diagnostics: getImageWorkerDiagnostics()
    }
  }, input)
  for (const name of ['ten', 'twelve']) {
    const frame = result.frames[name],
      fixture = generated[name],
      max = 2 ** fixture.depth - 1
    assert.equal(frame.colorSpace, 'srgb-linear')
    assert.deepEqual([frame.width, frame.height], [fixture.width, fixture.height])
    assert.equal(frame.provenance.sourceBits, fixture.depth)
    assert.equal(frame.provenance.precision, 'integer-source')
    assert.equal(frame.provenance.colorTransform, 'srgb')
    let maximumError = 0
    for (let i = 0; i < frame.data.length; i++) {
      const expected = i % 4 === 3 ? fixture.data[i] / max : decodeSrgb(fixture.data[i] / max)
      maximumError = Math.max(maximumError, Math.abs(frame.data[i] - expected))
    }
    assert.ok(maximumError < 2e-5, `actual ${fixture.depth}-bit values: ${maximumError}`)
    assert.ok(
      frame.data[0] > 0 && frame.data[4] < frame.data[8],
      'low code and within-byte differences survive'
    )
    assert.ok(Math.abs(frame.data[3] - 1 / max) < 1 / 65535, 'alpha remains straight normalized coverage')
    assert.ok(frame.data[1] > frame.data[0] && frame.data[2] > frame.data[1])
    assert.equal(frame.data[7], 0)
    assert.ok(frame.data[4] > 0, 'straight RGB beneath zero alpha must survive numeric decode')
  }
  for (const name of ['iccWide', 'cicpWide']) {
    const frame = result.frames[name]
    assert.ok(Math.abs(frame.data[0] - 1.224745) < 0.0004)
    assert.ok(Math.abs(frame.data[1] + 0.042058) < 0.0004)
    assert.ok(Math.abs(frame.data[2] + 0.019642) < 0.0004)
    assert.equal(frame.data[3], 1)
    assert.equal(frame.provenance.precision, 'integer-source')
    assert.equal(frame.provenance.sourceBits, 12)
    assert.equal(frame.provenance.colorTransform, name === 'iccWide' ? 'icc-matrix-trc' : 'display-p3')
  }
  assert.equal(result.frames.hdr.provenance.precision, 'rgba8-display')
  assert.equal(result.frames.hdr.provenance.compatibilityReason, 'avif-cicp')
  assert.equal(result.frames.hdr.provenance.sourceBits, 10)
  assert.ok(result.frames.hdr.data.every(Number.isFinite))
  assert.ok(result.failures.every((error) => error?.code === 'CODEC_ERROR'))
  assert.match(result.failures[1].message, /ICC profile/i)
  assert.equal(
    result.diagnosticsAfterFailures,
    result.diagnosticsBefore,
    'processed image failures must not retry through compatibility startup'
  )
  assert.deepEqual(result.recovered, result.frames.twelve.data)
  assert.deepEqual(result.fallback, result.frames.twelve.data)
  assert.deepEqual(result.fallbackProvenance, result.frames.twelve.provenance)
  assert.ok(result.sourceSame.every(Boolean))
  assert.deepEqual(result.diagnostics.at(-1).fallback, 'main-thread')
})

function tiffSamples(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ifd = UTIF.decode(buffer)[0]
  UTIF.decodeImage(buffer, ifd)
  const view = new DataView(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength)
  return {
    ifd,
    samples: Uint16Array.from({ length: view.byteLength / 2 }, (_, i) => view.getUint16(i * 2, true))
  }
}

test('GUI AVIF linear opt-in exports true TIFF16, reimports low bits, reloads and exposes compatibility provenance', async (t) => {
  const { page, run } = await workspace(t),
    fixture = (await fixtures()).twelve
  await page
    .locator('#files')
    .setInputFiles({ name: 'source12.avif', mimeType: 'image/avif', buffer: Buffer.from(fixture.bytes) })
  await page.locator('#gallery .tile').waitFor()
  await run('view', { mode: 'detail' })
  await page.locator('#processing-version').selectOption('2')
  await page.waitForFunction(
    async () => (await window.openlr.run('state')).processing?.input?.sourceBits === 12
  )
  const initial = await run('state')
  assert.equal(initial.processing.version, 2)
  assert.equal(initial.processing.input.precision, 'integer-source')
  assert.match(await page.locator('#info').textContent(), /12-bit/)
  const exported = Uint8Array.from(
      await page.evaluate(async () => {
        const { blob } = await window.openlr.run('export', { format: 'image/tiff' })
        return Array.from(new Uint8Array(await blob.arrayBuffer()))
      })
    ),
    decoded = tiffSamples(exported)
  assert.deepEqual(decoded.ifd.t258, [16, 16, 16, 16])
  let maximumError = 0,
    lowBits = 0,
    hiddenDifference = false
  const byteGroups = new Map()
  for (let i = 0; i < decoded.samples.length; i++) {
    maximumError = Math.max(
      maximumError,
      Math.abs(decoded.samples[i] - Math.round((fixture.data[i] * 65535) / 4095))
    )
    if (i % 4 === 0) {
      const sample = decoded.samples[i],
        byte = Math.round(sample / 257)
      if (sample % 257 !== 0) lowBits++
      if (byteGroups.has(byte) && byteGroups.get(byte) !== sample) hiddenDifference = true
      byteGroups.set(byte, sample)
    }
  }
  assert.ok(maximumError <= 2, `export code error ${maximumError}`)
  assert.ok(lowBits > 100)
  assert.equal(hiddenDifference, true)
  const original = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
    )
  )
  assert.deepEqual(original, Array.from(fixture.bytes))
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  await run('view', { mode: 'detail' })
  const reopenedAvif = await run('state')
  assert.equal(reopenedAvif.processing.version, 2)
  assert.equal(reopenedAvif.processing.input.sourceBits, 12)
  assert.equal(reopenedAvif.processing.input.precision, 'integer-source')
  const reopenedExport = Uint8Array.from(
    await page.evaluate(async () =>
      Array.from(
        new Uint8Array(await (await window.openlr.run('export', { format: 'image/tiff' })).blob.arrayBuffer())
      )
    )
  )
  assert.deepEqual(tiffSamples(reopenedExport).samples, decoded.samples)
  await page
    .locator('#files')
    .setInputFiles({ name: 'reimport.tif', mimeType: 'image/tiff', buffer: Buffer.from(exported) })
  await run('view', { mode: 'detail' })
  await run('processing', { version: 2 })
  const reimport = await run('state')
  assert.equal(reimport.processing.input.sourceBits, 16)
  assert.equal(reimport.processing.input.precision, 'uint16-source')
  const reexport = Uint8Array.from(
    await page.evaluate(async () =>
      Array.from(
        new Uint8Array(await (await window.openlr.run('export', { format: 'image/tiff' })).blob.arrayBuffer())
      )
    )
  )
  const reexported = tiffSamples(reexport).samples
  assert.ok(Math.max(...reexported.map((v, i) => Math.abs(v - decoded.samples[i]))) <= 3)
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  await run('view', { mode: 'detail' })
  const reopened = await run('state')
  assert.equal(reopened.processing.version, 2)
  assert.equal(reopened.processing.input.sourceBits, 16)
  assert.equal(reopened.processing.input.precision, 'uint16-source')
  const hdr = (await fixtures()).hdr
  await page
    .locator('#files')
    .setInputFiles({ name: 'compat10.avif', mimeType: 'image/avif', buffer: Buffer.from(hdr.bytes) })
  await run('view', { mode: 'detail' })
  await run('processing', { version: 2 })
  const compatible = await run('state')
  assert.equal(compatible.processing.input.precision, 'rgba8-display')
  assert.equal(compatible.processing.input.compatibilityReason, 'avif-cicp')
  assert.equal(compatible.processing.input.sourceBits, 10)
  assert.match(await page.locator('#info').textContent(), /8-bit compatibility decode/)
})
