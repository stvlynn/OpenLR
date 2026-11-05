import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'

const width = 48,
  height = 32,
  left = [64, 96, 128],
  right = [96, 128, 160],
  white = [255, 255, 255, 255]
const fixture = Buffer.from(
  makePng({
    width,
    height,
    bits: 8,
    srgb: 0,
    data: Array.from({ length: width * height }, (_, i) => (i % width < width / 2 ? left : right)).flat()
  })
)

for (const version of [1, 2]) {
  test(`compare from crop restores original stage pixels with processing version ${version}`, async (t) => {
    const server = await serveWorkspace()
    t.after(server.close)
    const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
    t.after(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    await page.goto(server.url)
    await page.waitForFunction(() => window.openlr)
    const run = (command, args = {}) =>
      page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args])
    const stage = () =>
      page.locator('#stage canvas').evaluate((canvas) => {
        const { width, height } = canvas,
          paint = canvas.getContext('2d')
        return {
          width,
          height,
          samples: [0.25, 0.75].map((x) =>
            Array.from(paint.getImageData(Math.floor(width * x), Math.floor(height / 2), 1, 1).data)
          )
        }
      })

    await page
      .locator('#files')
      .setInputFiles({ name: 'compare-crop.png', mimeType: 'image/png', buffer: fixture })
    await page.locator('#gallery .tile').waitFor()
    if (version === 2) await run('processing', { version })
    await run('crop-tool')
    const saved = await run('crop-drag', { grip: 'new', x1: 0, y1: 0, x2: 0.5, y2: 1 })
    const beforeExposure = (await run('crop-tool')).photos[0].edit
    assert.deepEqual(beforeExposure.crop, saved.cropDraft)
    const editedRecipe = (await run('edit', { key: 'Exposure', value: 5 })).photos[0].edit
    const editedStage = await stage()
    assert.ok(editedStage.width < editedStage.height, 'The saved crop narrows the displayed photo')
    assert.deepEqual(editedStage.samples, [white, white])

    await run('crop-tool')
    const draft = await run('crop-drag', { grip: 'new', x1: 0.5, y1: 0, x2: 1, y2: 1 })
    assert.notDeepEqual(draft.cropDraft, beforeExposure.crop)
    assert.deepEqual((await stage()).samples, [white, white])

    const compare = page.getByRole('button', { name: 'Show original' })
    if (version === 1) await compare.click()
    else await run('compare')
    // State is queued after the button command, including the asynchronous paint.
    const originalState = await run('state')
    const originalStage = await stage()
    assert.deepEqual(originalStage.samples, [
      [...left, 255],
      [...right, 255]
    ])
    assert.ok(originalStage.width > originalStage.height, 'Comparison shows the full original')
    assert.equal(originalState.compare, true)
    assert.equal(originalState.cropping, false)
    assert.equal(originalState.cropDraft, null)
    assert.equal(originalState.processing.version, version)
    assert.deepEqual(originalState.photos[0].edit, editedRecipe)
    assert.equal(await compare.getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator('.crop-surface').count(), 0)
    const originalBytes = await page.evaluate(async () => {
      const { blob } = await window.openlr.run('export', { format: 'original' })
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    })
    assert.deepEqual(Buffer.from(originalBytes), fixture)

    await run('compare')
    assert.deepEqual(await stage(), editedStage)
    assert.deepEqual((await run('crop-tool')).cropDraft, beforeExposure.crop)
    await run('crop-cancel')
    assert.deepEqual((await run('undo')).photos[0].edit, beforeExposure)
    assert.deepEqual((await run('redo')).photos[0].edit, editedRecipe)
    await page.reload()
    await page.waitForFunction(() => window.openlr)
    assert.deepEqual((await run('state')).photos[0].edit, editedRecipe)
  })
}
