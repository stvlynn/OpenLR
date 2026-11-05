import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'

const width = 1536,
  height = 32,
  column = 303,
  point = { x: (column + 0.5) / width, y: 0.5 },
  pixels = new Uint8Array(width * height * 3)
for (let row = 0; row < height; row++) {
  pixels[(row * width + column) * 3] = 255
  pixels[(row * width + column + 1) * 3] = 255
}
const original = Buffer.from(makePng({ width, height, bits: 8, colorType: 2, srgb: 0, data: pixels }))

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1400, height: 960 }, deviceScaleFactor: 1 })
  const run = (command, args = {}) =>
    page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args])
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page
    .locator('#files')
    .setInputFiles({ name: 'sampling-stripe.png', mimeType: 'image/png', buffer: original })
  await page.locator('#gallery .tile').waitFor()
  await run('view', { mode: 'detail' })
  await run('processing', { version: 2 })
  await run('zoom')
  await run('panel', { name: 'Point color', open: true })
  return { page, run }
}

async function stagePixel(page) {
  return page.locator('#stage canvas').evaluate(
    (canvas, column) => ({
      width: canvas.width,
      height: canvas.height,
      rgba: Array.from(canvas.getContext('2d').getImageData(column, canvas.height / 2, 1, 1).data)
    }),
    column
  )
}

async function clickPoint(page) {
  const bounds = await page.locator('#stage canvas').boundingBox()
  assert.equal(bounds?.width, width, '100% zoom displays one CSS pixel per source pixel')
  await page.mouse.click(bounds.x + bounds.width * point.x, bounds.y + bounds.height * point.y)
}

test('Point color GUI and dispatcher sample the visible pixel at 100% zoom', async (t) => {
  const { page, run } = await workspace(t)
  const before = await run('state')
  const photoId = before.selected
  const edit = before.photos[0].edit
  assert.equal(before.zoom, true)
  assert.deepEqual(await stagePixel(page), { width, height, rgba: [255, 0, 0, 255] })
  // At edge 1280, output column 252 samples halfway between black 302 and red 303.
  assert.deepEqual(await run('sample-color', point), { color: '#bc0000' })

  await page.getByRole('button', { name: 'Sample color', exact: true }).click()
  assert.equal((await run('state')).sampling, 'point')
  await clickPoint(page)
  // The state request follows the click's command in the queue.
  const gui = await run('state')
  const [guiPoint] = gui.photos[0].edit.pointColors
  assert.equal(guiPoint.color, '#ff0000')
  assert.equal(gui.selectedPoint, guiPoint.id)
  assert.equal(gui.sampling, false)
  await assert.rejects(() => run('point-sample', point), /eyedropper/i)

  await run('point-tool')
  await assert.rejects(
    () => run('point-sample', { ...point, photoId: 'stale-photo' }),
    /selected photo changed/i
  )
  for (const args of [{ ...point, x: -0.01 }, { ...point, y: 1.01 }, { ...point, x: NaN }, { x: point.x }]) {
    await assert.rejects(() => run('point-sample', args))
  }
  await run('clipping')
  await assert.rejects(() => run('point-sample', point), /clipping/i)
  await clickPoint(page)
  const clipped = await run('state')
  assert.equal(clipped.clipping, true)
  assert.equal(clipped.sampling, 'point')
  assert.deepEqual(clipped.photos[0].edit, gui.photos[0].edit)
  assert.equal(clipped.selectedPoint, guiPoint.id)
  await page.waitForFunction(() => /clipping/i.test(document.querySelector('#notice').textContent))
  await run('clipping')

  const cliPoint = await run('point-sample', { ...point, photoId })
  assert.deepEqual({ ...cliPoint, id: guiPoint.id }, guiPoint)
  assert.notEqual(cliPoint.id, guiPoint.id)
  const after = await run('state')
  assert.deepEqual(after.photos[0].edit, { ...edit, pointColors: [guiPoint, cliPoint] })
  assert.deepEqual(after.selection, before.selection)
  assert.equal(after.selectedPoint, cliPoint.id)
  assert.equal((await run('state', { summary: true })).selectedPoint, cliPoint.id)
  assert.equal(await page.getByLabel('Color sample', { exact: true }).inputValue(), cliPoint.id)
  assert.equal(after.sampling, false)
  assert.deepEqual(await run('sample-color', point), { color: '#bc0000' })

  assert.deepEqual((await run('undo')).photos[0].edit, gui.photos[0].edit)
  assert.deepEqual((await run('undo')).photos[0].edit, edit)
  await run('redo')
  assert.deepEqual((await run('redo')).photos[0].edit, after.photos[0].edit)
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  assert.deepEqual((await run('state')).photos[0].edit, after.photos[0].edit)
  const bytes = await page.evaluate(async () => {
    const { blob } = await window.openlr.run('export', { format: 'original' })
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  assert.deepEqual(Buffer.from(bytes), original)
})

test('Point color rejects a click on a canvas superseded by a queued photo edit', async (t) => {
  const { page, run } = await workspace(t)
  const before = await run('point-tool')
  assert.equal(before.sampling, 'point')
  assert.deepEqual((await stagePixel(page)).rgba, [255, 0, 0, 255])
  await page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob
    const canvas = document.querySelector('#stage canvas')
    const race = (window.pointSamplingRace = { canvas, clicked: false, release: null })
    canvas.addEventListener('click', (event) => (race.clicked = event.isTrusted), { once: true })
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      if (this.width !== 240) return toBlob.call(this, callback, ...args)
      HTMLCanvasElement.prototype.toBlob = toBlob
      // Run the real thumbnail encoder, but hold the edit before it saves and redraws.
      return toBlob.call(this, (blob) => (race.release = () => callback(blob)), ...args)
    }
    race.edit = window.openlr.run('edit', { key: 'Exposure', value: -1 })
  })
  await page.waitForFunction(() => Boolean(window.pointSamplingRace.release))
  assert.equal(
    await page.evaluate(() => document.querySelector('#stage canvas') === window.pointSamplingRace.canvas),
    true
  )
  await clickPoint(page)
  assert.equal(await page.evaluate(() => window.pointSamplingRace.clicked), true)
  await page.evaluate(async () => {
    window.pointSamplingRace.release()
    await window.pointSamplingRace.edit
  })
  const after = await run('state')
  assert.equal(after.selected, before.selected)
  assert.deepEqual(after.photos[0].edit, { ...before.photos[0].edit, Exposure: -1 })
  assert.equal(after.selectedPoint, '')
  assert.equal(after.sampling, 'point')
  assert.deepEqual((await stagePixel(page)).rgba, [188, 0, 0, 255])
  await page.waitForFunction(() =>
    /displayed image changed/i.test(document.querySelector('#notice').textContent)
  )
  assert.deepEqual((await run('undo')).photos[0].edit, before.photos[0].edit)
})
