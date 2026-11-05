import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'

const width = 360,
  height = 240,
  warm = [143, 119, 94],
  cool = [94, 119, 143],
  warmBalance = { Temperature: -65, Tint: 15 },
  coolBalance = { Temperature: 65, Tint: 15 },
  sourcePoint = { x: 0.25, y: 0.25 }

function fixture(left, right) {
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(x < width / 2 ? left : right, (y * width + x) * 3)
  return Buffer.from(makePng({ width, height, bits: 8, colorType: 2, srgb: 0, data }))
}
const warmOriginal = fixture(warm, cool),
  coolOriginal = fixture(cool, warm)
const editOf = (state, id = state.selected) => state.photos.find((photo) => photo.id === id).edit

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  t.diagnostic('Chrome ' + browser.version())
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const run = (command, args = {}) =>
    page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args])
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page.locator('#files').setInputFiles([
    { name: 'warm.png', mimeType: 'image/png', buffer: warmOriginal },
    { name: 'cool.png', mimeType: 'image/png', buffer: coolOriginal }
  ])
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)
  const { photos } = await run('state'),
    warmId = photos.find((photo) => photo.name === 'warm.png').id,
    coolId = photos.find((photo) => photo.name === 'cool.png').id
  await run('select', { id: warmId })
  await run('view', { mode: 'detail' })
  return { page, run, warmId, coolId }
}

async function clickCanvas(page, point) {
  const bounds = await page.locator('#stage canvas').boundingBox()
  assert.ok(bounds && bounds.width > 0)
  await page.mouse.click(bounds.x + bounds.width * point.x, bounds.y + bounds.height * point.y)
}

async function renderedPixel(page, command, point) {
  return page.evaluate(
    async ({ command, point }) => {
      const { blob } = await window.openlr.run(command, command === 'preview' ? {} : { format: 'image/png' })
      const image = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d')
      ctx.drawImage(
        image,
        Math.floor(point.x * image.width),
        Math.floor(point.y * image.height),
        1,
        1,
        0,
        0,
        1,
        1
      )
      image.close()
      return Array.from(ctx.getImageData(0, 0, 1, 1).data)
    },
    { command, point }
  )
}

test('White balance GUI and display command sample the original patch through edited geometry', async (t) => {
  const { page, run, warmId, coolId } = await workspace(t)
  await run('processing', { version: 2 })
  await run('edit', { key: 'crop', value: { x: 0.08, y: 0.1, w: 0.83, h: 0.8 } })
  await run('edit', { key: 'turn', value: 1 })
  await run('edit', { key: 'flip', value: true })
  await run('optics', { changes: { vertical: 8, horizontal: -5, rotate: 3, scale: 110 } })
  await run('edit', { key: 'Exposure', value: 0.5 })
  const before = editOf(await run('state'))
  const viewPoint = await page.evaluate(
    async ({ point, width, height, edit }) => {
      const { originalToView } = await import('./local-tools-ui.js')
      return originalToView(point, { width, height }, edit)
    },
    { point: sourcePoint, width, height, edit: before }
  )
  assert.ok(viewPoint.x > 0.5 && viewPoint.x < 1 && viewPoint.y > 0.5 && viewPoint.y < 1)
  const baselinePixel = await renderedPixel(page, 'preview', viewPoint)
  assert.notDeepEqual(baselinePixel.slice(0, 3), warm, 'Exposure changes the displayed swatch')
  await assert.rejects(() => run('white-balance-sample', viewPoint), /activate.*sampler/i)
  await assert.rejects(
    () => run('white-balance', { ...sourcePoint, photoId: coolId }),
    /selected photo changed/i
  )

  const button = page.getByRole('button', { name: 'White balance sampler', exact: true })
  await button.click()
  assert.equal((await run('state')).sampling, 'white')
  await assert.rejects(
    () => run('white-balance-sample', { ...viewPoint, photoId: coolId }),
    /selected photo changed/i
  )
  await assert.rejects(() => run('white-balance-sample', { ...viewPoint, x: 1.01 }), /valid range/i)
  await clickCanvas(page, viewPoint)
  const gui = await run('state'),
    expected = { ...before, ...warmBalance }
  assert.equal(gui.selected, warmId)
  assert.deepEqual(editOf(gui), expected)
  assert.equal(gui.sampling, false)
  assert.equal(await button.getAttribute('aria-pressed'), 'false')
  const balancedPixel = await renderedPixel(page, 'preview', viewPoint)
  assert.notDeepEqual(balancedPixel, baselinePixel)
  assert.deepEqual(await renderedPixel(page, 'export', viewPoint), balancedPixel)
  assert.deepEqual(editOf(await run('undo')), before)

  await run('sample-tool')
  const command = await run('white-balance-sample', { ...viewPoint, photoId: warmId })
  assert.deepEqual(editOf(command), expected)
  assert.deepEqual(await renderedPixel(page, 'preview', viewPoint), balancedPixel)
  assert.deepEqual(editOf(await run('undo')), before)
  assert.deepEqual(editOf(await run('white-balance', { ...sourcePoint, photoId: warmId })), expected)
  assert.deepEqual(await renderedPixel(page, 'export', viewPoint), balancedPixel)
  assert.deepEqual(editOf(await run('undo')), before)
  // At source pixel center x=180.5, the patch contains two warm and three cool columns.
  const mixedPatch = await run('white-balance', { x: (width / 2 + 0.5) / width, y: sourcePoint.y })
  assert.deepEqual(editOf(mixedPatch), { ...before, Temperature: 12, Tint: -12 })
  assert.deepEqual(editOf(await run('undo')), before)
  await run('white-balance', sourcePoint)
  assert.deepEqual(editOf(await run('undo')), before)
  assert.deepEqual(editOf(await run('redo')), expected)

  await page.reload()
  await page.waitForFunction(() => window.openlr)
  const reopened = await run('state')
  assert.deepEqual(editOf(reopened, warmId), expected)
  assert.deepEqual(editOf(reopened, coolId), {})
  await run('select', { id: warmId })
  const original = await page.evaluate(async () => {
    const { blob } = await window.openlr.run('export', { format: 'original' })
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  assert.deepEqual(Buffer.from(original), warmOriginal)
})

test('White balance refuses trusted clicks on an old canvas after queued selection or edit', async (t) => {
  const { page, run, warmId, coolId } = await workspace(t)
  await run('sample-tool')
  for (const nextPhoto of [coolId, null]) {
    await page.evaluate((nextPhoto) => {
      const toBlob = HTMLCanvasElement.prototype.toBlob
      const canvas = document.querySelector('#stage canvas')
      const race = (window.whiteBalanceRace = { canvas, clicked: false, release: null })
      canvas.addEventListener('click', (event) => (race.clicked = event.isTrusted), { once: true })
      HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
        if (this.width !== 240) return toBlob.call(this, callback, ...args)
        HTMLCanvasElement.prototype.toBlob = toBlob
        // Run the real thumbnail encoder and delay only completion of its callback.
        return toBlob.call(this, (blob) => (race.release = () => callback(blob)), ...args)
      }
      race.done = window.openlr.run('edit', { key: 'Exposure', value: -1 })
      if (nextPhoto) race.done = window.openlr.run('select', { id: nextPhoto })
    }, nextPhoto)
    await page.waitForFunction(() => Boolean(window.whiteBalanceRace.release))
    assert.equal(
      await page.evaluate(() => document.querySelector('#stage canvas') === window.whiteBalanceRace.canvas),
      true
    )
    await clickCanvas(page, sourcePoint)
    assert.equal(await page.evaluate(() => window.whiteBalanceRace.clicked), true)
    await page.evaluate(async () => {
      window.whiteBalanceRace.release()
      await window.whiteBalanceRace.done
    })
    const after = await run('state')
    assert.equal(after.selected, nextPhoto ?? warmId)
    assert.equal(after.sampling, 'white')
    assert.deepEqual(editOf(after, warmId), { Exposure: -1 })
    assert.deepEqual(editOf(after, coolId), {})
    const message = nextPhoto ? /selected photo changed/i : /displayed image changed/i
    await page.waitForFunction(
      (pattern) => new RegExp(pattern, 'i').test(document.querySelector('#notice').textContent),
      message.source
    )
    if (nextPhoto) {
      await clickCanvas(page, sourcePoint)
      const retry = await run('state')
      assert.deepEqual(editOf(retry, coolId), coolBalance)
      assert.deepEqual(editOf(await run('undo'), coolId), {})
      await run('select', { id: warmId })
      await run('sample-tool')
    }
    assert.deepEqual(editOf(await run('undo'), warmId), {})
  }
})
