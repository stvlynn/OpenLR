import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { exportColorSpaces, validateExportColorSpace } from '../web/export-color.js'
import { validateArgs } from '../web/agent-protocol.js'

test('output color capabilities reject unsupported combinations without relabeling', () => {
  assert.equal(exportColorSpaces('image/png').length, 5)
  assert.deepEqual(exportColorSpaces('image/avif'), ['srgb'])
  for (const format of ['original', 'image/x-adobe-dng', 'video/mp4', 'application/rdf+xml']) {
    assert.equal(validateExportColorSpace(format), 'srgb')
    assert.throws(() => validateExportColorSpace(format, 'srgb'))
  }
  assert.throws(() => validateExportColorSpace('image/jxl', 'display-p3'))
  assert.throws(() => validateArgs('export', { format: 'image/avif', colorSpace: 'display-p3' }))
})

test('GUI and agent export actual tagged colors, round-trip through import and preserve originals', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 80
    const ctx = canvas.getContext('2d')
    for (const [index, color] of [
      'rgb(180,60,40)',
      'rgb(45,160,70)',
      'rgb(50,70,190)',
      'rgb(128,128,128)'
    ].entries()) {
      ctx.fillStyle = color
      ctx.fillRect(index * 40, 0, 40, 80)
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve))
    window.sourceBytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
    await window.openlr.run('import', { files: [new File([blob], 'color.png', { type: 'image/png' })] })
  })
  await page.locator('#export').click()
  await page.locator('#format').selectOption('image/png')
  await page.locator('#export-color-space').selectOption('display-p3')
  const options = await page.evaluate(async () => (await import('./export-options.js')).readExportOptions())
  assert.equal(options.colorSpace, 'display-p3')
  const downloaded = page.waitForEvent('download')
  await page.locator('#export-dialog button[value=ok]').click()
  const stream = await (await downloaded).createReadStream(),
    chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.ok(Buffer.concat(chunks).includes(Buffer.from('iCCP')))
  await page.locator('#export').click()
  await page.locator('#format').selectOption('image/avif')
  assert.equal(await page.locator('#export-color-space').inputValue(), 'srgb')
  assert.equal(await page.locator('#export-color-space').isDisabled(), true)
  await page.locator('#format').selectOption('original')
  assert.equal(await page.locator('#export-color-space').isVisible(), false)
  await page.locator('#export-dialog button[value=cancel]').click()
  const records = await page.evaluate(async () => {
    const { decodePhoto } = await import('./decode.js')
    const { makeColorProfile } = await import('./color-spaces.js')
    const { encodeColorTiff } = await import('./color-containers.js')
    for (const invalid of ['header', 'layout', 'tag-table']) {
      const profile = makeColorProfile('display-p3')
      if (invalid === 'header') profile[36] = 0
      else if (invalid === 'layout') profile.set(new TextEncoder().encode('CMYK'), 16)
      else new DataView(profile.buffer).setUint32(128, 65535)
      const file = new File(
        [encodeColorTiff({ width: 1, height: 1, data: new Uint8Array([80, 90, 100, 255]) }, profile)],
        'invalid-profile.tif',
        { type: 'image/tiff' }
      )
      let rejected = false
      try {
        await decodePhoto(file)
      } catch {
        rejected = true
      }
      if (!rejected) throw Error('Invalid TIFF color profile silently ignored')
    }
    const { run } = window.openlr
    const { encodePhoto } = await import('./encode.js')
    const transparent = document.createElement('canvas')
    transparent.width = transparent.height = 16
    const transparentContext = transparent.getContext('2d')
    transparentContext.fillStyle = 'rgba(180,60,40,0.5)'
    transparentContext.fillRect(0, 0, 16, 16)
    const readJpeg = async (colorSpace) => {
      const bitmap = await decodePhoto(
        new File([await encodePhoto(transparent, 'image/jpeg', 1, colorSpace)], 'alpha.jpg', {
          type: 'image/jpeg'
        })
      )
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 16
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      return Array.from(ctx.getImageData(8, 8, 1, 1).data)
    }
    const flattened = await readJpeg('srgb'),
      managedAlpha = await readJpeg('display-p3')
    if (managedAlpha[3] !== 255 || managedAlpha.some((value, i) => Math.abs(value - flattened[i]) > 3))
      throw Error('JPEG output color conversion changed transparency compositing')
    const before = await run('state')
    const colors = [
      [180, 60, 40],
      [45, 160, 70],
      [50, 70, 190],
      [128, 128, 128]
    ]
    const result = []
    for (const colorSpace of ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020']) {
      for (const [format, extension] of [
        ['image/png', 'png'],
        ['image/tiff', 'tif'],
        ['image/jpeg', 'jpg']
      ]) {
        const { blob } = await run('export', { format, colorSpace, quality: 1 })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const bitmap = await decodePhoto(new File([blob], `result.${extension}`, { type: format }))
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        const pixels = colors.map((_, i) =>
          Array.from(ctx.getImageData(i * 40 + 20, 40, 1, 1).data).slice(0, 3)
        )
        const maxError = Math.max(
          ...pixels.flatMap((pixel, i) => pixel.map((value, c) => Math.abs(value - colors[i][c])))
        )
        result.push({
          colorSpace,
          format,
          maxError,
          pixels,
          tagged: new TextDecoder('latin1').decode(bytes).includes(format === 'image/png' ? 'iCCP' : 'acsp')
        })
      }
    }
    for (const args of [
      { format: 'original', colorSpace: 'display-p3' },
      { format: 'image/avif', colorSpace: 'prophoto-rgb' }
    ]) {
      let rejected = false
      try {
        await run('export', args)
      } catch {
        rejected = true
      }
      if (!rejected) throw Error('Unsupported color request silently ignored')
    }
    const original = await run('export', { format: 'original' })
    const after = await run('state')
    return {
      result,
      editUnchanged: JSON.stringify(before.photos[0].edit) === JSON.stringify(after.photos[0].edit),
      sourceUnchanged:
        JSON.stringify(Array.from(new Uint8Array(await original.blob.arrayBuffer()))) ===
        JSON.stringify(window.sourceBytes)
    }
  })
  assert.equal(records.editUnchanged, true)
  assert.equal(records.sourceUnchanged, true)
  for (const row of records.result) {
    assert.ok(row.maxError <= (row.format === 'image/jpeg' ? 5 : 3), JSON.stringify(row))
    if (row.colorSpace !== 'srgb' || row.format === 'image/tiff')
      assert.equal(row.tagged, true, JSON.stringify(row))
  }
  console.log('Managed color round trips:', JSON.stringify(records.result))
})
