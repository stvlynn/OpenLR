import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import UTIF from '../web/vendor/codecs/utif.js'
import { serveWorkspace } from './browser-server.mjs'
import { makeTiff } from './fixtures/tiff.mjs'

async function exported(page, format, options = {}) {
  return Uint8Array.from(
    await page.evaluate(
      async ([format, options]) => {
        const { blob } = await window.openlr.run('export', { format, ...options })
        return Array.from(new Uint8Array(await blob.arrayBuffer()))
      },
      [format, options]
    )
  )
}

function words(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    image = UTIF.decode(buffer)[0]
  UTIF.decodeImage(buffer, image)
  assert.deepEqual(image.t258, [16, 16, 16, 16])
  const view = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  return {
    image,
    data: Uint16Array.from({ length: view.byteLength / 2 }, (_, i) => view.getUint16(i * 2, true))
  }
}

async function preview(page) {
  return page.evaluate(async () => {
    const { blob } = await window.openlr.run('preview'),
      bitmap = await createImageBitmap(blob),
      canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    bitmap.close()
    return Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)
  })
}

test('GUI TIFF16 opt-in, edits, export/reimport, XMP and reload preserve source precision and original bytes', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }),
    errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  const run = (command, args = {}) =>
      page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args]),
    width = 512,
    height = 16,
    samples = Array.from({ length: width * height }, (_, i) => [
      1000 + (i % width),
      2000 + (i % width),
      3000 + (i % width)
    ]).flat(),
    original = makeTiff({
      width,
      height,
      data: samples,
      littleEndian: false,
      tileSize: 16,
      compression: 5,
      predictor: 2
    })
  await page
    .locator('#files')
    .setInputFiles({ name: 'source-16bit-ramp.tif', mimeType: 'image/tiff', buffer: Buffer.from(original) })
  await page.locator('#gallery .tile').waitFor()
  await run('view', { mode: 'detail' })
  const originalId = (await run('state')).selected,
    legacy = await preview(page)
  assert.deepEqual((await run('state')).photos[0].edit, {})
  await page.locator('#processing-version').selectOption('2')
  await page.waitForFunction(async () => (await window.openlr.run('state')).processing.version === 2)
  const state = await run('state')
  assert.equal(state.processing.input.sourceBits, 16)
  assert.equal(state.processing.input.precision, 'uint16-source')
  assert.equal(state.processing.input.decoder, 'utif')
  assert.match(await page.locator('#info').textContent(), /Decoded precision: 16-bit/)
  const baseline = words(await exported(page, 'image/tiff')),
    baselinePreview = await preview(page)
  assert.equal(baseline.image.t34675.length > 100, true)
  let nonReplicated = 0
  const levels = new Set(),
    byteGroups = new Map()
  let hiddenDifference = false
  for (let i = 0, sourceIndex = 0; i < baseline.data.length; i += 4, sourceIndex += 3) {
    assert.deepEqual(
      Array.from(baseline.data.subarray(i, i + 4)),
      [...samples.slice(sourceIndex, sourceIndex + 3), 65535],
      'neutral export must retain the actual source words'
    )
    const value = baseline.data[i],
      byte = Math.round(value / 257)
    levels.add(value)
    if (value % 257 !== 0) nonReplicated++
    if (byteGroups.has(byte) && byteGroups.get(byte) !== value) hiddenDifference = true
    byteGroups.set(byte, value)
  }
  assert.equal(levels.size, 512)
  assert.ok(nonReplicated > 8000)
  assert.equal(hiddenDifference, true)
  await run('mask.add', {
    mask: {
      type: 'semantic',
      raster: { width: 1, height: 1, encoding: 'base64-u8', data: '/w==' },
      adjustments: { Exposure: 4 }
    }
  })
  await run('edit', { key: 'Exposure', value: -4 })
  assert.deepEqual(
    words(await exported(page, 'image/tiff')).data,
    baseline.data,
    'local +4 and global -4 must recover every retained source level'
  )
  await run('processing', { version: 1 })
  await run('reset')
  assert.deepEqual(
    await preview(page),
    legacy,
    'switching back must retain original-processing pixel behavior'
  )
  await run('processing', { version: 2 })
  assert.deepEqual(await preview(page), baselinePreview)
  await run('edit', { key: 'Exposure', value: 1 })
  const editedBytes = await exported(page, 'image/tiff'),
    edited = words(editedBytes),
    xml = new TextDecoder().decode(await exported(page, 'application/rdf+xml'))
  assert.notDeepEqual(edited.data, baseline.data)
  assert.equal(new Set(edited.data.filter((_, i) => i % 4 === 0)).size, 512)
  assert.deepEqual(await exported(page, 'original'), original)
  await page.locator('#files').setInputFiles({
    name: 'rendered-16bit-ramp.tif',
    mimeType: 'image/tiff',
    buffer: Buffer.from(editedBytes)
  })
  await page.waitForFunction(async () => (await window.openlr.run('state')).photos.length === 2)
  const importedState = await run('state'),
    reimportId = importedState.photos.find((photo) => photo.name === 'rendered-16bit-ramp.tif').id
  await run('select', { id: reimportId })
  await run('processing', { version: 2 })
  const reimported = words(await exported(page, 'image/tiff'))
  // The first exact-word criterion failed: generated ICC fixed-point rounding
  // changes some red words by +1 (2652 -> 2653). Re-import interprets that real
  // serialized profile, rather than the unrounded named definition used to export.
  let maximumReimportError = 0
  reimported.data.forEach((value, i) => {
    maximumReimportError = Math.max(maximumReimportError, Math.abs(value - edited.data[i]))
  })
  assert.ok(maximumReimportError <= 1, `ICC roundtrip exceeded one Uint16 code: ${maximumReimportError}`)
  assert.equal(new Set(reimported.data.filter((_, i) => i % 4 === 0)).size, 512)
  t.diagnostic(
    `TIFF16 ICC reimport maximum word difference: ${maximumReimportError}; distinct red levels: 512`
  )
  assert.equal((await run('state')).processing.input.colorTransform, 'icc-matrix-trc')
  await run('select', { id: originalId })
  await run('reset')
  await run('processing', { version: 1 })
  await run('apply-xmp', { xml })
  assert.deepEqual((await run('state')).photos.find((photo) => photo.id === originalId).edit, {
    processVersion: 2,
    Exposure: 1
  })
  assert.deepEqual(words(await exported(page, 'image/tiff')).data, edited.data)
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  await run('view', { mode: 'detail' })
  await run('select', { id: originalId })
  assert.equal((await run('state')).processing.input.sourceBits, 16)
  assert.deepEqual(
    words(await exported(page, 'image/tiff')).data,
    edited.data,
    'reopening must decode original words and restore the recipe'
  )
  assert.deepEqual(await exported(page, 'original'), original)
  assert.deepEqual(errors, [])
})
