import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'

const data = new Uint8Array(60 * 40 * 3)
for (let i = 0; i < data.length; i += 3) data.set([64, 96, 128], i)
const original = Buffer.from(makePng({ width: 60, height: 40, bits: 8, colorType: 2, srgb: 0, data }))
const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
const active = (state) => state.photos.find((photo) => photo.id === state.selected)
const defaults = () => ({
  shadows: { hue: 0, saturation: 0, luminance: 0 },
  midtones: { hue: 0, saturation: 0, luminance: 0 },
  highlights: { hue: 0, saturation: 0, luminance: 0 },
  global: { hue: 0, saturation: 0, luminance: 0 },
  balance: 0,
  blending: 50
})
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
    .setInputFiles({ name: 'grading-source.png', mimeType: 'image/png', buffer: original })
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 1)
  await run(page, 'view', { mode: 'detail' })
  await page.locator('#color-grading > summary').click()
  return page
}
async function stageSample(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#stage canvas')
    return Array.from(
      canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)
        .data
    )
  })
}
async function waitStage(page, previous, equal) {
  await waitForAsyncFunction(
    page,
    ({ previous, equal }) => {
      const canvas = document.querySelector('#stage canvas')
      if (!canvas) return false
      const pixel = Array.from(
        canvas
          .getContext('2d')
          .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
      )
      return (JSON.stringify(pixel) === JSON.stringify(previous)) === equal
    },
    { previous, equal }
  )
}
async function wheel(page, x = 0, y = 0) {
  await page.locator('#grading-wheel-global').scrollIntoViewIfNeeded()
  const box = await page.locator('#grading-wheel-global').boundingBox()
  return { x: box.x + box.width * (0.5 + 0.44 * x), y: box.y + box.height * (0.5 - 0.44 * y) }
}
async function exportedPixel(page) {
  return page.evaluate(async () => {
    const { blob } = await window.openlr.run('export', { format: 'image/png' })
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    return Array.from(ctx.getImageData(10, 10, 1, 1).data)
  })
}
const doubled = [64, 96, 128].map((v) => {
  const encoded = v / 255
  const linear = encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4
  const value = linear * 2
  return Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055))
})

test('grading wheel previews real pixels, commits once and supports cancellation, numeric controls and shared mode state', async (t) => {
  const page = await workspace(t)
  await page.locator('#grading-mode').selectOption('global')
  await waitForAsyncFunction(
    page,
    async () => (await window.openlr.run('state')).colorGrading.mode === 'global'
  )
  assert.equal((await run(page, 'state', { summary: true })).colorGrading.mode, 'global')
  const before = active(await run(page, 'state')).edit
  const baseline = await stageSample(page)
  const center = await wheel(page)
  const red = await wheel(page, 0.65)
  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.mouse.move(red.x, red.y, { steps: 4 })
  await waitStage(page, baseline, false)
  assert.deepEqual(active(await run(page, 'state')).edit, before)
  await page.mouse.up()
  await waitForAsyncFunction(page, async () => {
    const state = await window.openlr.run('state')
    return state.photos.find((photo) => photo.id === state.selected).edit.colorGrading?.global.saturation > 50
  })
  const graded = active(await run(page, 'state')).edit
  await run(page, 'undo')
  assert.deepEqual(active(await run(page, 'state')).edit, before)
  await waitStage(page, baseline, true)
  await run(page, 'redo')
  assert.deepEqual(active(await run(page, 'state')).edit, graded)
  const committedPixels = await stageSample(page)
  const green = await wheel(page, -0.5, 0.4)
  await page.mouse.move(red.x, red.y)
  await page.mouse.down()
  await page.mouse.move(green.x, green.y)
  await waitStage(page, committedPixels, false)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await waitStage(page, committedPixels, true)
  assert.deepEqual(active(await run(page, 'state')).edit, graded)
  await page.locator('#grading-global-hue').fill('120')
  await page.locator('#grading-global-hue').press('Tab')
  await waitForAsyncFunction(page, async () => {
    const state = await window.openlr.run('state')
    return state.photos.find((photo) => photo.id === state.selected).edit.colorGrading.global.hue === 120
  })
  await page.locator('#grading-wheel-global').focus()
  await page.keyboard.press('ArrowRight')
  await waitForAsyncFunction(page, async () => {
    const state = await window.openlr.run('state')
    return state.photos.find((photo) => photo.id === state.selected).edit.colorGrading.global.hue === 121
  })
  await page.locator('#grading-global-luminance').focus()
  await page.keyboard.press('ArrowRight')
  await waitForAsyncFunction(page, async () => {
    const state = await window.openlr.run('state')
    return state.photos.find((photo) => photo.id === state.selected).edit.colorGrading.global.luminance === 1
  })
  await page.locator('#grading-balance-number').fill('-25')
  await page.locator('#grading-balance-number').press('Tab')
  await page.locator('#grading-blending-number').fill('80')
  await page.locator('#grading-blending-number').press('Tab')
  await waitForAsyncFunction(page, async () => {
    const state = await window.openlr.run('state')
    const value = state.photos.find((photo) => photo.id === state.selected).edit.colorGrading
    return value.balance === -25 && value.blending === 80
  })
  const sharedControls = active(await run(page, 'state')).edit.colorGrading
  await run(page, 'grading-set', {
    value: { ...sharedControls, shadows: { hue: 240, saturation: 10, luminance: 0 } }
  })
  await page.locator('#grading-global-reset').click()
  await waitForAsyncFunction(page, async () => {
    const state = await window.openlr.run('state')
    return state.photos.find((photo) => photo.id === state.selected).edit.colorGrading.global.saturation === 0
  })
  const wheelReset = active(await run(page, 'state')).edit.colorGrading
  assert.equal(wheelReset.shadows.saturation, 10)
  assert.equal(wheelReset.global.luminance, 0)
  assert.equal(wheelReset.balance, -25)
  assert.equal(wheelReset.blending, 80)
  await page.locator('#grading-reset').click()
  await waitStage(page, baseline, true)
  await run(page, 'grading-set', { value: { global: { hue: 220 }, balance: 30, blending: 70 } })
  await run(page, 'filter', { edited: 'no' })
  assert.equal(
    (await run(page, 'state')).photos.length,
    1,
    'Dormant hue and blend choices do not mark the image edited'
  )
})

test('grading exports linear luminance changes in both processes and round-trips snapshots, presets, XMP, selective copy and reload', async (t) => {
  const page = await workspace(t)
  const source = (await run(page, 'state')).selected
  for (const version of [1, 2]) {
    await run(page, 'processing', { version })
    await run(page, 'grading-set', { value: { global: { luminance: 50 } } })
    const rgba = await exportedPixel(page)
    doubled.forEach((value, channel) =>
      assert.ok(
        Math.abs(rgba[channel] - value) <= 1,
        `Process ${version} channel ${channel}: ${rgba[channel]} expected ${value}`
      )
    )
    assert.equal(rgba[3], 255)
    await run(page, 'grading-set', { value: defaults() })
    assert.deepEqual(await exportedPixel(page), [64, 96, 128, 255])
  }
  await run(page, 'grading-set', {
    value: { shadows: { hue: 220, saturation: 30 }, global: { luminance: 10 }, balance: 15, blending: 70 }
  })
  const saved = active(await run(page, 'state')).edit
  const preset = await run(page, 'preset-save', { name: 'Grading proof' })
  const version = await run(page, 'version-save', { name: 'Grading version' })
  const xml = await page.evaluate(async () => {
    const state = await window.openlr.run('state')
    return (await import('./xmp.js')).exportXmp(state.photos.find((photo) => photo.id === state.selected))
  })
  await run(page, 'reset')
  await run(page, 'preset-apply', { id: preset.id })
  assert.deepEqual(active(await run(page, 'state')).edit.colorGrading, saved.colorGrading)
  await run(page, 'reset')
  await run(page, 'version-restore', { id: version.id })
  assert.deepEqual(active(await run(page, 'state')).edit, saved)
  await run(page, 'reset')
  await run(page, 'apply-xmp', { xml })
  assert.deepEqual(active(await run(page, 'state')).edit, saved)
  await run(page, 'copy-edits', { keys: ['colorGrading'] })
  await page
    .locator('#files')
    .setInputFiles({ name: 'grading-target.png', mimeType: 'image/png', buffer: original })
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)
  const target = (await run(page, 'state')).selected
  await run(page, 'edit', { key: 'Exposure', value: 0.5 })
  await run(page, 'paste-edits')
  assert.deepEqual(active(await run(page, 'state')).edit, { Exposure: 0.5, colorGrading: saved.colorGrading })
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  await run(page, 'select', { id: target })
  assert.deepEqual(active(await run(page, 'state')).edit.colorGrading, saved.colorGrading)
  await run(page, 'select', { id: source })
  await run(page, 'reset')
  await run(page, 'copy-edits', { keys: ['colorGrading'] })
  await run(page, 'select', { id: target })
  await run(page, 'paste-edits')
  assert.deepEqual(active(await run(page, 'state')).edit, { Exposure: 0.5 })
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
    )
  )
  assert.deepEqual(bytes, Array.from(original))
})

test('grading rejects stale and invalid changes and cancels a live wheel draft when selecting another photo', async (t) => {
  const page = await workspace(t)
  const source = (await run(page, 'state')).selected
  await run(page, 'grading-set', { value: { global: { luminance: 20 } } })
  const before = active(await run(page, 'state')).edit
  for (const args of [
    { value: { balance: 20 }, photoId: 'another-photo' },
    { value: { balance: 20 }, expectedValue: defaults() },
    { value: { global: { luminance: 101 } } },
    { value: { unknownWheel: { hue: 10 } } }
  ])
    await assert.rejects(() => run(page, 'grading-set', args))
  assert.deepEqual(active(await run(page, 'state')).edit, before)
  await page
    .locator('#files')
    .setInputFiles({ name: 'grading-other.png', mimeType: 'image/png', buffer: original })
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)
  const other = (await run(page, 'state')).selected
  await run(page, 'select', { id: source })
  await run(page, 'view', { mode: 'detail' })
  await run(page, 'grading-mode', { mode: 'global' })
  const baseline = await stageSample(page)
  const center = await wheel(page)
  const red = await wheel(page, 0.7)
  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.mouse.move(red.x, red.y)
  await waitStage(page, baseline, false)
  await run(page, 'select', { id: other })
  await page.mouse.up()
  await waitStage(page, [64, 96, 128, 255], true)
  const state = await run(page, 'state')
  assert.equal(active(state).edit.colorGrading, undefined)
  assert.deepEqual(state.photos.find((photo) => photo.id === source).edit, before)
  await run(page, 'select', { id: source })
  await run(page, 'undo')
  assert.equal(
    active(await run(page, 'state')).edit.colorGrading,
    undefined,
    'Refused changes and canceled drafts add no undo entries'
  )
})
