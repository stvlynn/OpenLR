import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'
import UTIF from '../web/vendor/codecs/utif.js'

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

async function output(page, command = 'export', args = { format: 'image/tiff' }) {
  return Uint8Array.from(
    await page.evaluate(
      async ([command, args]) => {
        const { blob } = await window.openlr.run(command, args)
        return Array.from(new Uint8Array(await blob.arrayBuffer()))
      },
      [command, args]
    )
  )
}

function tiff(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ifd = UTIF.decode(buffer)[0]
  UTIF.decodeImage(buffer, ifd)
  const view = new DataView(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength)
  return {
    ifd,
    samples: Uint16Array.from({ length: view.byteLength / 2 }, (_, i) => view.getUint16(i * 2, true))
  }
}

test('GUI PNG16 Linear opt-in preserves low samples through TIFF16, original reload and TIFF reimport while legacy pixels stay unchanged', async (t) => {
  const { page, run } = await workspace(t),
    width = 128,
    height = 16,
    samples = Uint16Array.from({ length: width * height * 4 }, (_, i) =>
      i % 4 === 3 ? 65535 : 16384 + (Math.floor(i / 4) % width)
    )
  samples.set([1, 2, 3, 1, 32768, 1024, 4096, 0])
  const bytes = makePng({
    width,
    height,
    bits: 16,
    colorType: 6,
    data: samples,
    srgb: 0,
    interlace: 1,
    filter: [0, 1, 2, 3, 4]
  })
  await page
    .locator('#files')
    .setInputFiles({ name: 'source16.png', mimeType: 'image/png', buffer: Buffer.from(bytes) })
  await page.locator('#gallery .tile').waitFor()
  await run('view', { mode: 'detail' })
  assert.equal((await run('state')).processing.version, 1)
  const legacy = await output(page, 'preview', {})
  await page.locator('#processing-version').selectOption('2')
  await page.waitForFunction(
    async () => (await window.openlr.run('state')).processing?.input?.sourceBits === 16
  )
  const state = await run('state')
  assert.equal(state.processing.version, 2)
  assert.equal(state.processing.input.precision, 'uint16-source')
  assert.equal(state.processing.input.pngColorSource, 'srgb')
  assert.match(await page.locator('#info').textContent(), /16-bit/)
  const exported = await output(page),
    decoded = tiff(exported)
  assert.deepEqual(decoded.ifd.t258, [16, 16, 16, 16])
  assert.deepEqual([decoded.ifd.width, decoded.ifd.height], [width, height])
  let maximumError = 0,
    lowSamples = 0,
    hiddenDifference = false
  const byteGroups = new Map()
  for (let i = 0; i < samples.length; i++) {
    maximumError = Math.max(maximumError, Math.abs(decoded.samples[i] - samples[i]))
    if (i % 4 === 0) {
      const value = decoded.samples[i],
        byte = Math.round(value / 257)
      if (value % 257) lowSamples++
      if (byteGroups.has(byte) && byteGroups.get(byte) !== value) hiddenDifference = true
      byteGroups.set(byte, value)
    }
  }
  assert.ok(maximumError <= 1, `PNG16 to TIFF16 code error ${maximumError}`)
  assert.ok(lowSamples > 100)
  assert.equal(hiddenDifference, true)
  assert.equal(decoded.samples[7], 0)
  assert.ok(decoded.samples[4] > 32000, 'transparent RGB is preserved outside display surfaces')
  assert.deepEqual(await output(page, 'export', { format: 'original' }), bytes)
  await run('processing', { version: 1 })
  assert.deepEqual(await output(page, 'preview', {}), legacy)
  await run('processing', { version: 2 })
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  await run('view', { mode: 'detail' })
  assert.equal((await run('state')).processing.input.sourceBits, 16)
  assert.deepEqual(tiff(await output(page)).samples, decoded.samples)
  assert.deepEqual(await output(page, 'export', { format: 'original' }), bytes)
  await page
    .locator('#files')
    .setInputFiles({ name: 'reimport16.tif', mimeType: 'image/tiff', buffer: Buffer.from(exported) })
  await run('view', { mode: 'detail' })
  await run('processing', { version: 2 })
  const imported = await run('state')
  assert.equal(imported.processing.input.sourceBits, 16)
  assert.equal(imported.processing.input.precision, 'uint16-source')
  const reexport = tiff(await output(page)).samples
  assert.ok(Math.max(...reexport.map((v, i) => Math.abs(v - decoded.samples[i]))) <= 3)
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  await run('view', { mode: 'detail' })
  assert.equal((await run('state')).processing.version, 2)
  assert.equal((await run('state')).processing.input.sourceBits, 16)
  assert.deepEqual(tiff(await output(page)).samples, reexport)
})

test('GUI PNG unsupported CICP exposes actual compatibility provenance and visible Info text', async (t) => {
  const { page, run } = await workspace(t),
    bytes = makePng({
      width: 8,
      height: 4,
      bits: 16,
      colorType: 2,
      data: Array(8 * 4 * 3).fill(16384),
      cicp: [9, 16, 0, 1]
    })
  await page
    .locator('#files')
    .setInputFiles({ name: 'compat16.png', mimeType: 'image/png', buffer: Buffer.from(bytes) })
  await page.locator('#gallery .tile').waitFor()
  await run('view', { mode: 'detail' })
  await run('processing', { version: 2 })
  const { processing } = await run('state')
  assert.equal(processing.version, 2)
  assert.equal(processing.input.sourceBits, 16)
  assert.equal(processing.input.precision, 'rgba8-display')
  assert.equal(processing.input.compatibilityReason, 'png-cicp')
  assert.match(await page.locator('#info').textContent(), /8-bit compatibility decode/)
  assert.deepEqual(await output(page, 'export', { format: 'original' }), bytes)
})

test('GUI damaged PNG palette exposes the recovery warning in state and Info', async (t) => {
  const { page, run } = await workspace(t),
    bytes = makePng({
      width: 3,
      height: 1,
      bits: 8,
      colorType: 3,
      data: [0, 1, 2],
      palette: [
        [255, 0, 0],
        [0, 255, 0]
      ],
      srgb: 0
    })
  await page
    .locator('#files')
    .setInputFiles({ name: 'damaged-palette.png', mimeType: 'image/png', buffer: Buffer.from(bytes) })
  await page.locator('#gallery .tile').waitFor()
  await run('view', { mode: 'detail' })
  await run('processing', { version: 2 })
  const state = await run('state')
  assert.ok(state.processing.input.colorWarnings.includes('png-palette-index'))
  assert.match(await page.locator('#info').textContent(), /Some pixels could not be recovered\./)
  assert.deepEqual(await output(page, 'export', { format: 'original' }), bytes)
})
