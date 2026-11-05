import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import UTIF from '../web/vendor/codecs/utif.js'
import { serveWorkspace } from './browser-server.mjs'
import { jxlInputCases } from './fixtures/jxl-input.mjs'
import { encodeSrgb } from '../web/color-spaces.js'

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

async function exported(page, format = 'image/tiff') {
  return Uint8Array.from(
    await page.evaluate(async (format) => {
      const { blob } = await window.openlr.run('export', { format })
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    }, format)
  )
}

function tiffWords(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    image = UTIF.decode(buffer)[0]
  UTIF.decodeImage(buffer, image)
  const view = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  assert.deepEqual(image.t258, [16, 16, 16, 16])
  return {
    image,
    data: Uint16Array.from({ length: view.byteLength / 2 }, (_, i) => view.getUint16(i * 2, true))
  }
}

async function preview(page) {
  return page.evaluate(async () => {
    const { blob } = await window.openlr.run('preview'),
      bitmap = await createImageBitmap(blob),
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
      context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data)
  })
}

test('GUI JPEG XL16 opt-in retains low words through edits, TIFF16 reimport, XMP/reload and exact original export', async (t) => {
  const { page, run } = await workspace(t),
    bytes = new Uint8Array(await readFile(new URL('./fixtures/jxl/srgb16.jxl', import.meta.url))),
    source = jxlInputCases().srgb16
  await page
    .locator('#files')
    .setInputFiles({ name: 'native16.jxl', mimeType: 'image/jxl', buffer: Buffer.from(bytes) })
  await page.locator('#gallery .tile').waitFor()
  await run('view', { mode: 'detail' })
  const initial = await run('state'),
    originalId = initial.selected,
    legacy = await preview(page)
  assert.equal(initial.processing.version, 1)
  await page.locator('#processing-version').selectOption('2')
  const upgraded = await run('state', { summary: true })
  assert.equal(upgraded.processing.version, 2)
  assert.equal(upgraded.processing.input.decoder, 'libjxl')
  assert.equal(upgraded.processing.input.sourceBits, 16)
  assert.equal(upgraded.processing.input.outputBits, 32)
  assert.equal(upgraded.processing.input.precision, 'integer-source')
  assert.match(await page.locator('#info').textContent(), /16-bit/)
  const baseline = tiffWords(await exported(page))
  assert.deepEqual([baseline.image.width, baseline.image.height], [source.width, source.height])
  let maximumWordError = 0,
    lowWords = 0,
    hiddenDifference = false
  const groups = new Map(),
    levels = new Set()
  baseline.data.forEach((value, i) => {
    maximumWordError = Math.max(maximumWordError, Math.abs(value - source.data[i]))
    if (i % 4 === 0) {
      levels.add(value)
      if (value % 257) lowWords++
      const byte = Math.round(value / 257)
      if (groups.has(byte) && groups.get(byte) !== value) hiddenDifference = true
      groups.set(byte, value)
    }
  })
  assert.ok(maximumWordError <= 2, `JXL16 to TIFF16 maximum word error ${maximumWordError}`)
  assert.equal(levels.size, 512)
  assert.ok(lowWords > 8000)
  assert.equal(hiddenDifference, true)
  t.diagnostic(
    `JXL16 TIFF16 maximum source word error: ${maximumWordError}; low red words: ${lowWords}; levels: ${levels.size}`
  )
  await run('mask.add', {
    mask: {
      type: 'semantic',
      raster: { width: 1, height: 1, encoding: 'base64-u8', data: '/w==' },
      adjustments: { Exposure: 4 }
    }
  })
  await run('edit', { key: 'Exposure', value: -4 })
  assert.deepEqual(tiffWords(await exported(page)).data, baseline.data)
  await run('processing', { version: 1 })
  await run('reset')
  assert.deepEqual(await preview(page), legacy)
  await run('processing', { version: 2 })
  await run('edit', { key: 'Exposure', value: 1 })
  const editedBytes = await exported(page),
    edited = tiffWords(editedBytes),
    xml = new TextDecoder().decode(await exported(page, 'application/rdf+xml'))
  assert.notDeepEqual(edited.data, baseline.data)
  assert.deepEqual(await exported(page, 'original'), bytes)
  await page
    .locator('#files')
    .setInputFiles({ name: 'jxl-rendered16.tif', mimeType: 'image/tiff', buffer: Buffer.from(editedBytes) })
  const reimportId = (await run('state')).photos.find((photo) => photo.name === 'jxl-rendered16.tif').id
  await run('select', { id: reimportId })
  await run('processing', { version: 2 })
  const reimported = tiffWords(await exported(page)).data
  let maximumReimportError = 0
  reimported.forEach((value, i) => {
    maximumReimportError = Math.max(maximumReimportError, Math.abs(value - edited.data[i]))
  })
  assert.ok(maximumReimportError <= 3, `JXL TIFF16 reimport maximum word error ${maximumReimportError}`)
  assert.equal(new Set(reimported.filter((_, i) => i % 4 === 0)).size, 512)
  await run('select', { id: originalId })
  await run('reset')
  await run('processing', { version: 1 })
  await run('apply-xmp', { xml })
  assert.equal((await run('state')).processing.version, 2)
  assert.deepEqual(tiffWords(await exported(page)).data, edited.data)
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  await run('view', { mode: 'detail' })
  await run('select', { id: originalId })
  assert.equal((await run('state')).processing.input.sourceBits, 16)
  assert.deepEqual(tiffWords(await exported(page)).data, edited.data)
  assert.deepEqual(await exported(page, 'original'), bytes)
})

test('GUI JPEG XL float input retains recoverable highlights and labels unsupported HDR transfer compatibility', async (t) => {
  const { page, run } = await workspace(t),
    bytes = await readFile(new URL('./fixtures/jxl/linear-float.jxl', import.meta.url))
  await page
    .locator('#files')
    .setInputFiles({ name: 'linear-float.jxl', mimeType: 'image/jxl', buffer: bytes })
  await page.locator('#gallery .tile').waitFor()
  await run('view', { mode: 'detail' })
  await run('processing', { version: 2 })
  const state = await run('state')
  assert.equal(state.processing.input.precision, 'float-source')
  assert.equal(state.processing.input.sourceBits, 32)
  assert.equal(state.processing.input.sourceExponentBits, 8)
  assert.match(await page.locator('#info').textContent(), /32-bit/)
  assert.equal(tiffWords(await exported(page)).data[2], 65535)
  await run('edit', { key: 'Exposure', value: -2 })
  const recovered = tiffWords(await exported(page)).data
  assert.ok(
    Math.abs(recovered[2] - Math.round(encodeSrgb(1.5 / 4) * 65535)) <= 3,
    'highlight must be recovered from the source value above one'
  )
  const compatibility = await readFile(new URL('./fixtures/jxl/pq16.jxl', import.meta.url))
  await page
    .locator('#files')
    .setInputFiles({ name: 'pq16.jxl', mimeType: 'image/jxl', buffer: compatibility })
  const id = (await run('state')).photos.find((photo) => photo.name === 'pq16.jxl').id
  await run('select', { id })
  await run('processing', { version: 2 })
  const compatible = await run('state', { summary: true })
  assert.equal(compatible.processing.input.precision, 'rgba8-display')
  assert.equal(compatible.processing.input.compatibilityReason, 'jxl-hdr-transfer')
  assert.equal(compatible.processing.input.sourceBits, 16)
  assert.match(await page.locator('#info').textContent(), /8-bit compatibility decode/)
  assert.deepEqual(await exported(page, 'original'), new Uint8Array(compatibility))
})
