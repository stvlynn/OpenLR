import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { exportColorSpaces, validateExportColorSpace } from '../web/export-color.js'
import { validateArgs } from '../web/agent-protocol.js'

test('output color capabilities reject unsupported combinations without relabeling', () => {
  const spaces = ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020']
  for (const format of ['image/png', 'image/tiff', 'image/jpeg', 'image/avif', 'image/jxl']) {
    assert.deepEqual(exportColorSpaces(format), spaces)
    for (const colorSpace of spaces) {
      assert.equal(validateExportColorSpace(format, colorSpace), colorSpace)
      assert.doesNotThrow(() => validateArgs('export', { format, colorSpace }))
    }
  }
  for (const format of [
    'original',
    'original-settings',
    'image/x-adobe-dng',
    'video/mp4',
    'application/rdf+xml'
  ]) {
    assert.equal(validateExportColorSpace(format), 'srgb')
    assert.throws(() => validateExportColorSpace(format, 'srgb'))
    assert.throws(() => validateArgs('export', { format, colorSpace: 'srgb' }))
  }
})

for (const processVersion of [1, 2])
  test(`GUI and agent export actual tagged colors, round-trip through import and preserve originals (processing ${processVersion})`, async (t) => {
    const server = await serveWorkspace()
    t.after(server.close)
    const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
    t.after(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(server.url)
    await page.evaluate(async (processVersion) => {
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
      if (processVersion === 2) await window.openlr.run('processing', { version: processVersion })
      await window.openlr.run('edit', { key: 'flip', value: true })
    }, processVersion)
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
    for (const format of ['image/png', 'image/tiff', 'image/jpeg', 'image/avif', 'image/jxl']) {
      await page.locator('#format').selectOption(format)
      assert.equal(await page.locator('#export-color-space').isDisabled(), false)
      for (const colorSpace of ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020']) {
        await page.locator('#export-color-space').selectOption(colorSpace)
        const selected = await page.evaluate(async () =>
          (await import('./export-options.js')).readExportOptions()
        )
        assert.equal(selected.format, format)
        assert.equal(selected.colorSpace, colorSpace)
      }
    }
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
        [128, 128, 128],
        [50, 70, 190],
        [45, 160, 70],
        [180, 60, 40]
      ]
      const result = []
      const hasSignature = (bytes, format) => {
        const matches = (offset, values) => values.every((value, i) => bytes[offset + i] === value)
        if (format === 'image/png') return matches(0, [137, 80, 78, 71, 13, 10, 26, 10])
        if (format === 'image/jpeg') return matches(0, [255, 216, 255])
        if (format === 'image/tiff') return matches(0, [73, 73, 42, 0]) || matches(0, [77, 77, 0, 42])
        if (format === 'image/avif')
          return (
            matches(4, [102, 116, 121, 112]) &&
            new TextDecoder('latin1').decode(bytes.subarray(8, 32)).includes('avif')
          )
        return matches(0, [255, 10]) || matches(0, [0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10])
      }
      for (const colorSpace of ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020']) {
        for (const [format, extension] of [
          ['image/png', 'png'],
          ['image/tiff', 'tif'],
          ['image/jpeg', 'jpg'],
          ['image/avif', 'avif'],
          ['image/jxl', 'jxl']
        ]) {
          const { blob } = await run('export', { format, colorSpace, quality: 1 })
          const bytes = new Uint8Array(await blob.arrayBuffer())
          const bitmap = await decodePhoto(new File([blob], `result.${extension}`, { type: format }))
          if (bitmap.width !== 160 || bitmap.height !== 80) throw Error('Export changed image dimensions')
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
            mimeType: blob.type,
            maxError,
            pixels,
            signatureValid: hasSignature(bytes, format)
          })
        }
      }
      for (const format of [
        'original',
        'original-settings',
        'image/x-adobe-dng',
        'video/mp4',
        'application/rdf+xml'
      ]) {
        let rejected = false
        try {
          await run('export', { format, colorSpace: 'display-p3' })
        } catch {
          rejected = true
        }
        if (!rejected) throw Error('Unsupported color request silently ignored')
      }
      const original = await run('export', { format: 'original' })
      const after = await run('state')
      return {
        result,
        recipe: after.photos[0].edit,
        editUnchanged: JSON.stringify(before.photos[0].edit) === JSON.stringify(after.photos[0].edit),
        sourceUnchanged:
          JSON.stringify(Array.from(new Uint8Array(await original.blob.arrayBuffer()))) ===
          JSON.stringify(window.sourceBytes)
      }
    })
    assert.equal(records.editUnchanged, true)
    assert.equal(records.sourceUnchanged, true)
    assert.deepEqual(
      records.recipe,
      processVersion === 1 ? { flip: true } : { processVersion: 2, flip: true }
    )
    assert.equal(records.result.length, 25)
    for (const row of records.result) {
      assert.equal(row.mimeType, row.format, JSON.stringify(row))
      assert.ok(row.maxError <= (row.format === 'image/jpeg' ? 5 : 3), JSON.stringify(row))
      assert.equal(row.signatureValid, true, JSON.stringify(row))
    }
    console.log(`Managed color round trips (processing ${processVersion}):`, JSON.stringify(records.result))
  })
