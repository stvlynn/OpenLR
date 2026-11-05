import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'

const copyright = 'OpenLR generated sharpening fixture'
function fixture() {
  const width = 96,
    height = 64,
    data = []
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value =
        95 + 32 * Math.sin((x * Math.PI) / 6) + 18 * Math.cos((y * Math.PI) / 8) + (x >= 48 ? 35 : 0)
      data.push(
        Math.round(value),
        Math.round(value + 12),
        Math.round(value + 24),
        x < 6 ? 0 : x < 12 ? 128 : 255
      )
    }
  const xmp =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:rights><rdf:Alt><rdf:li xml:lang="x-default">' +
    copyright +
    '</rdf:li></rdf:Alt></dc:rights></rdf:Description></rdf:RDF></x:xmpmeta>'
  return makePng({
    width,
    height,
    bits: 8,
    colorType: 6,
    data,
    srgb: 0,
    beforeIdat: [['iTXt', new TextEncoder().encode('XML:com.adobe.xmp\0\0\0\0\0' + xmp)]]
  })
}
async function workspace(t, input = fixture()) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page
    .locator('#files')
    .setInputFiles({ name: 'sharpen.png', mimeType: 'image/png', buffer: Buffer.from(input) })
  await page.locator('#gallery .tile').waitFor()
  return { page, input }
}
const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])

test('output sharpening changes actual rendered files at final size while preserving alpha, profiles, metadata, edits and originals', async (t) => {
  const { page, input } = await workspace(t)
  const results = await page.evaluate(async () => {
    const { run } = window.openlr,
      { decodePhoto } = await import('./decode.js'),
      { metadata } = await import('./metadata.js'),
      { readPng } = await import('./png.js'),
      { makeColorProfile } = await import('./color-spaces.js'),
      { decodeJxl } = await import('./color-codecs.js'),
      { default: UTIF } = await import('./vendor/codecs/utif.js'),
      expectedProfile = makeColorProfile('display-p3'),
      rows = [],
      stable = []
    const bytes = async (result) => new Uint8Array(await result.blob.arrayBuffer())
    const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i])
    const contains = (data, needle) => {
      outer: for (let offset = 0; offset <= data.length - needle.length; offset++) {
        for (let i = 0; i < needle.length; i++) if (data[offset + i] !== needle[i]) continue outer
        return true
      }
      return false
    }
    for (const version of [1, 2]) {
      await run('processing', { version })
      const before = await run('state'),
        beforePreview = await bytes(await run('preview'))
      for (const format of ['image/jpeg', 'image/png', 'image/tiff', 'image/avif', 'image/jxl']) {
        const options = { format, quality: 1, colorSpace: 'display-p3', metadata: 'copyright', maxSize: 48 },
          defaultBytes = await bytes(await run('export', options))
        let baseline
        for (const outputSharpening of ['none', 'low', 'standard', 'high']) {
          const result = await run('export', { ...options, outputSharpening }),
            encoded = await bytes(result),
            file = new File([encoded], result.filename, { type: format }),
            bitmap = await decodePhoto(file),
            canvas = document.createElement('canvas')
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const ctx = canvas.getContext('2d')
          ctx.drawImage(bitmap, 0, 0)
          bitmap.close()
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
          if (outputSharpening === 'none') baseline = pixels
          let energy = 0,
            changed = 0,
            alphaEqual = true
          for (let y = 2; y < canvas.height - 2; y++)
            for (let x = 8; x < canvas.width - 2; x++) {
              const i = (y * canvas.width + x) * 4
              energy += (pixels[i] - pixels[i - 4]) ** 2
              if (pixels[i] !== baseline[i]) changed++
            }
          for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== baseline[i]) alphaEqual = false
          let profile =
            format === 'image/png'
              ? readPng(encoded).metadata.icc
              : format === 'image/jxl'
                ? (await decodeJxl(encoded.buffer)).originalICC
                : null
          let bits,
            lowWords = 0
          if (format === 'image/tiff') {
            const ifd = UTIF.decode(encoded.buffer)[0]
            bits = ifd.t258
            if (version === 2) {
              UTIF.decodeImage(encoded.buffer, ifd)
              const view = new DataView(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength)
              for (let i = 0; i < view.byteLength; i += 2) if (view.getUint16(i, true) % 257) lowWords++
            }
          }
          rows.push({
            version,
            format,
            outputSharpening,
            width: canvas.width,
            height: canvas.height,
            energy,
            changed,
            alphaEqual,
            bits,
            lowWords,
            metadata: await metadata(file, { strict: true }),
            profileCorrect: profile ? same(profile, expectedProfile) : contains(encoded, expectedProfile),
            defaultExact: outputSharpening !== 'none' || same(defaultBytes, encoded),
            captured: result.exportSettings.options.outputSharpening
          })
        }
      }
      const after = await run('state')
      stable.push({
        edit: JSON.stringify(before.photos[0].edit) === JSON.stringify(after.photos[0].edit),
        preview: same(beforePreview, await bytes(await run('preview'))),
        original: Array.from(await bytes(await run('export', { format: 'original' })))
      })
    }
    return { rows, stable }
  })
  assert.equal(results.rows.length, 40)
  for (const row of results.rows) {
    const label = `${row.version} ${row.format} ${row.outputSharpening}`
    assert.deepEqual([row.width, row.height], [48, 32], label)
    assert.equal(row.defaultExact, true, label + ': none retains old bytes')
    assert.equal(row.profileCorrect, true, label + ': actual target ICC')
    assert.equal(row.alphaEqual, true, label + ': alpha unchanged')
    assert.equal(row.metadata.Copyright, copyright, label)
    assert.equal(row.captured, row.outputSharpening === 'none' ? undefined : row.outputSharpening)
    if (row.outputSharpening !== 'none') assert.ok(row.changed > 20, label + ': actual sharpened pixels')
    if (row.format === 'image/tiff') {
      assert.deepEqual(row.bits, [
        row.version === 2 ? 16 : 8,
        row.version === 2 ? 16 : 8,
        row.version === 2 ? 16 : 8,
        row.version === 2 ? 16 : 8
      ])
      if (row.version === 2) assert.ok(row.lowWords > 100, label + ': retained 16-bit output')
    }
  }
  for (const version of [1, 2])
    for (const format of ['image/png', 'image/tiff']) {
      const rows = results.rows.filter((row) => row.version === version && row.format === format)
      for (let i = 1; i < rows.length; i++)
        assert.ok(rows[i].energy > rows[i - 1].energy, `${version} ${format}: increasing output contrast`)
    }
  for (const state of results.stable) {
    assert.equal(state.edit, true)
    assert.equal(state.preview, true)
    assert.deepEqual(Uint8Array.from(state.original), input)
  }
})

test('GUI output sharpening saves actual bytes, repeats after reload, and cancellation leaves the completed choice intact', async (t) => {
  const { page } = await workspace(t)
  await page.locator('#export').click()
  await page.locator('#format').selectOption('image/png')
  await page.locator('#export-size').fill('48')
  await page.locator('#export-sharpening').selectOption('standard')
  const pending = page.waitForEvent('download')
  await page.locator('#export-dialog button[value=ok]').click()
  const download = await pending,
    saved = await readFile(await download.path())
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem('export-settings') || '{}').photo?.outputSharpening === 'standard'
  )
  assert.equal((await run(page, 'export-settings')).photo.outputSharpening, 'standard')
  const repeated = await page.evaluate(() => window.openlr.dispatch('export-previous'))
  assert.deepEqual(Buffer.from(repeated.result.base64, 'base64'), saved)
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  await page.locator('#export').click()
  assert.equal(await page.locator('#export-sharpening').inputValue(), 'standard')
  await page.locator('#export-sharpening').selectOption('high')
  await page.locator('#export-dialog button[value=cancel]').click()
  assert.equal((await run(page, 'export-settings')).photo.outputSharpening, 'standard')
  const afterCancel = await page.evaluate(() => window.openlr.dispatch('export-previous'))
  assert.deepEqual(Buffer.from(afterCancel.result.base64, 'base64'), saved)
  await page.locator('#export').click()
  await page.locator('#format').selectOption('original')
  assert.equal(await page.locator('#export-sharpening').isVisible(), false)
  await page.locator('#export-dialog button[value=cancel]').click()
  const invalid = await page.evaluate(() =>
    window.openlr.dispatch('export', { format: 'original', outputSharpening: 'high' })
  )
  assert.equal(invalid.ok, false)
})

test('output sharpening precedes watermark compositing in both processing versions', async (t) => {
  const input = makePng({
      width: 128,
      height: 96,
      bits: 8,
      colorType: 6,
      srgb: 0,
      data: Array.from({ length: 128 * 96 * 4 }, (_, i) => [84, 121, 153, 255][i % 4])
    }),
    { page } = await workspace(t, input)
  const rows = await page.evaluate(async () => {
    const { run } = window.openlr,
      rows = []
    const bytes = async (args) =>
      Array.from(new Uint8Array(await (await run('export', args)).blob.arrayBuffer()))
    for (const version of [1, 2]) {
      await run('processing', { version })
      const options = { format: 'image/png', maxSize: 64 },
        plain = await bytes(options),
        none = await bytes({ ...options, watermark: 'OpenLR', outputSharpening: 'none' }),
        high = await bytes({ ...options, watermark: 'OpenLR', outputSharpening: 'high' })
      rows.push({ version, plain, none, high })
    }
    return rows
  })
  for (const row of rows) {
    assert.notDeepEqual(row.none, row.plain, `${row.version}: text was actually composited`)
    assert.deepEqual(
      row.high,
      row.none,
      `${row.version}: uniform photo stays uniform and text edges are not sharpened`
    )
  }
})
