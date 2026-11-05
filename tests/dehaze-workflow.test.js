import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'

const width = 96,
  height = 64
const data = new Uint8Array(width * height * 3)
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const rgb =
      y < 8
        ? [255, 255, 255]
        : x % 7 === 0 && y % 7 === 0
          ? [100, 110, 120]
          : x < 48
            ? [160, 170, 180]
            : [190, 195, 200]
    data.set(rgb, (y * width + x) * 3)
  }
const original = Buffer.from(makePng({ width, height, bits: 8, colorType: 2, srgb: 0, data }))
const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
const active = (state) => state.photos.find((photo) => photo.id === state.selected)
async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page
    .locator('#files')
    .setInputFiles({ name: 'dehaze-source.png', mimeType: 'image/png', buffer: original })
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 1)
  await run(page, 'view', { mode: 'detail' })
  await run(page, 'panel', { name: 'Effects', open: true })
  return page
}
async function raster(page, command = 'export', args = {}) {
  return page.evaluate(
    async ([command, args]) => {
      const result = await window.openlr.run(command, {
        ...(command === 'export' ? { format: 'image/png' } : {}),
        ...args
      })
      const bitmap = await createImageBitmap(result.blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      return {
        width: canvas.width,
        height: canvas.height,
        pixels: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data)
      }
    },
    [command, args]
  )
}
const pixel = (image, x, y) => image.pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)
const hazeExpected = [160, 170, 180].map((byte) => {
  const encoded = byte / 255
  const linear = encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4
  const hazy = 0.4 * linear + 0.6
  return Math.round(255 * (hazy <= 0.0031308 ? hazy * 12.92 : 1.055 * hazy ** (1 / 2.4) - 0.055))
})

test('Dehaze changes actual exports in both processes while crop and output size retain source-based estimation', async (t) => {
  const page = await workspace(t)
  for (const version of [1, 2]) {
    await run(page, 'processing', { version })
    await run(page, 'edit', { key: 'crop', value: { x: 0, y: 0, w: 1, h: 1 } })
    await run(page, 'edit', { key: 'Dehaze', value: 0 })
    const neutral = await raster(page)
    assert.deepEqual(pixel(neutral, 21, 31), [160, 170, 180, 255])
    await run(page, 'edit', { key: 'Dehaze', value: 60 })
    const positive = await raster(page)
    pixel(positive, 21, 31)
      .slice(0, 3)
      .forEach((value, channel) =>
        assert.ok(
          value < [160, 170, 180][channel],
          `Positive process ${version} channel ${channel} must remove the generated veil`
        )
      )
    await run(page, 'edit', { key: 'crop', value: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } })
    const cropped = await raster(page)
    assert.deepEqual([cropped.width, cropped.height], [48, 32])
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 48; x++)
        assert.deepEqual(
          pixel(cropped, x, y),
          pixel(positive, x + 24, y + 16),
          `Crop must not re-estimate airlight (process ${version}, ${x},${y})`
        )
    const smallPreview = await raster(page, 'preview', { maxSize: 24 })
    const smallExport = await raster(page, 'export', { maxSize: 24 })
    assert.deepEqual([smallPreview.width, smallPreview.height], [24, 16])
    assert.deepEqual(smallPreview, smallExport)
    await run(page, 'edit', { key: 'crop', value: { x: 0, y: 0, w: 1, h: 1 } })
    await run(page, 'edit', { key: 'Dehaze', value: -100 })
    const negative = pixel(await raster(page), 21, 31)
    hazeExpected.forEach((value, channel) =>
      assert.ok(
        Math.abs(negative[channel] - value) <= 1,
        `Negative process ${version} channel ${channel}: ${negative[channel]} expected ${value}`
      )
    )
    assert.equal(negative[3], 255)
    await run(page, 'edit', { key: 'Dehaze', value: 60 })
    await run(page, 'optics', { changes: { manualDistortion: 20 } })
    const corrected = await raster(page)
    assert.notDeepEqual(corrected.pixels, positive.pixels)
    await page.reload()
    await page.waitForFunction(() => window.openlr)
    assert.deepEqual(
      await raster(page),
      corrected,
      'Changed optics must match a fresh source analysis after reload'
    )
    await run(page, 'optics-reset')
  }
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
    )
  )
  assert.deepEqual(bytes, Array.from(original))
})

test('Effects Dehaze uses slider history, preset/version/XMP and selective-copy persistence without altering other adjustments', async (t) => {
  const page = await workspace(t)
  const slider = page.locator('[data-control="Dehaze"]')
  await slider.focus()
  await page.keyboard.press('ArrowRight')
  await waitForAsyncFunction(page, async () => {
    const state = await window.openlr.run('state')
    return state.photos.find((photo) => photo.id === state.selected).edit.Dehaze === 1
  })
  await run(page, 'undo')
  assert.equal(active(await run(page, 'state')).edit.Dehaze, undefined)
  await run(page, 'redo')
  assert.equal(await slider.inputValue(), '1')
  await run(page, 'edit', { key: 'Dehaze', value: 35 })
  const source = (await run(page, 'state')).selected
  const saved = active(await run(page, 'state')).edit
  await assert.rejects(() => run(page, 'edit', { key: 'Dehaze', value: 101 }), /range|between|maximum|100/i)
  assert.deepEqual(active(await run(page, 'state')).edit, saved)
  const preset = await run(page, 'preset-save', { name: 'Dehaze proof' })
  const version = await run(page, 'version-save', { name: 'Dehaze version' })
  const xml = await page.evaluate(async () => {
    const state = await window.openlr.run('state')
    return (await import('./xmp.js')).exportXmp(state.photos.find((photo) => photo.id === state.selected))
  })
  await run(page, 'reset')
  await run(page, 'preset-apply', { id: preset.id })
  assert.equal(active(await run(page, 'state')).edit.Dehaze, 35)
  await run(page, 'reset')
  await run(page, 'version-restore', { id: version.id })
  assert.deepEqual(active(await run(page, 'state')).edit, saved)
  await run(page, 'reset')
  await run(page, 'apply-xmp', { xml })
  assert.deepEqual(active(await run(page, 'state')).edit, saved)
  await run(page, 'view', { mode: 'grid' })
  await page.locator('#choose-edits').click()
  await page.locator('#copy-edits-none').click()
  await page.locator('#copy-edits-dialog input[value="effects"]').check()
  await page.evaluate(() => {
    window.dehazeCopyClosed = new Promise((resolve) =>
      document.querySelector('#copy-edits-dialog').addEventListener('close', resolve, { once: true })
    )
  })
  await page.locator('#copy-edits-confirm').click()
  await page.evaluate(() => window.dehazeCopyClosed)
  assert.ok((await run(page, 'state')).clipboard.keys.includes('Dehaze'))
  await page
    .locator('#files')
    .setInputFiles({ name: 'dehaze-target.png', mimeType: 'image/png', buffer: original })
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)
  const target = (await run(page, 'state')).selected
  await run(page, 'edit', { key: 'Exposure', value: 0.5 })
  await run(page, 'paste-edits')
  assert.deepEqual(active(await run(page, 'state')).edit, { Exposure: 0.5, Dehaze: 35 })
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  await run(page, 'select', { id: target })
  assert.deepEqual(active(await run(page, 'state')).edit, { Exposure: 0.5, Dehaze: 35 })
  await run(page, 'select', { id: source })
  await run(page, 'reset')
  await run(page, 'copy-edits', { keys: ['Dehaze'] })
  await run(page, 'select', { id: target })
  await run(page, 'paste-edits')
  assert.deepEqual(active(await run(page, 'state')).edit, { Exposure: 0.5 })
})
