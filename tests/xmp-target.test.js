import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'

const pixels = new Uint8Array(40 * 30 * 3).fill(96)
const original = Buffer.from(makePng({ width: 40, height: 30, bits: 8, colorType: 2, srgb: 0, data: pixels }))
const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
const content = (photo) => ({
  id: photo.id,
  edit: photo.edit,
  rating: photo.rating,
  flag: photo.flag,
  keywords: photo.keywords
})

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page
    .locator('#files')
    .setInputFiles(
      ['intended.png', 'other.png'].map((name) => ({ name, mimeType: 'image/png', buffer: original }))
    )
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)
  const state = await run(page, 'state')
  const first = state.photos[0].id,
    second = state.photos[1].id
  await run(page, 'select', { id: first })
  await run(page, 'view', { mode: 'detail' })
  const xml = await page.evaluate(async () => {
    const { exportXmp } = await import('./xmp.js')
    return exportXmp({ edit: { Exposure: 1.25 }, rating: 4, flag: 'pick', keywords: 'generated, 青色' })
  })
  return { page, first, second, xml }
}

// Inject only file I/O timing/failure; the real file-input handler and dispatcher execute unchanged.
async function controlledRead(page, failure = false) {
  await page.evaluate((failure) => {
    const originalText = File.prototype.text
    File.prototype.text = async function () {
      if (this.name === 'controlled.xmp') {
        window.xmpReadStarted = true
        await new Promise((resolve) => (window.releaseXmpRead = resolve))
        File.prototype.text = originalText
        if (failure) throw Error('Generated XMP read failure')
      }
      return originalText.call(this)
    }
  }, failure)
}
async function chooseXmp(page, xml) {
  await page
    .locator('#xmp-file')
    .setInputFiles({ name: 'controlled.xmp', mimeType: 'application/rdf+xml', buffer: Buffer.from(xml) })
}
async function finishRead(page) {
  await page.evaluate(() => window.releaseXmpRead())
  await page.waitForFunction(() => document.querySelector('#xmp-file').value === '')
}

test('delayed GUI XMP reading never applies to a newly selected photo', async (t) => {
  const { page, first, second, xml } = await workspace(t)
  const before = (await run(page, 'state')).photos.map(content)
  await controlledRead(page)
  await chooseXmp(page, xml)
  await page.waitForFunction(() => window.xmpReadStarted)
  await run(page, 'select', { id: second })
  await finishRead(page)
  const after = await run(page, 'state')
  assert.equal(after.selected, second)
  assert.deepEqual(after.photos.map(content), before)
  assert.match(await page.locator('#notice').textContent(), /changed|selected/i)
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  assert.deepEqual((await run(page, 'state')).photos.map(content), before, 'Stale XMP never reached storage')
  await run(page, 'select', { id: first })
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
    )
  )
  assert.deepEqual(bytes, Array.from(original))
})

test('delayed GUI XMP reading preserves a newer edit on the same photo and adds no undo entry', async (t) => {
  const { page, first, xml } = await workspace(t)
  await controlledRead(page)
  await chooseXmp(page, xml)
  await page.waitForFunction(() => window.xmpReadStarted)
  await run(page, 'edit', { key: 'Exposure', value: 2 })
  const before = (await run(page, 'state')).photos.map(content)
  await finishRead(page)
  assert.deepEqual((await run(page, 'state')).photos.map(content), before)
  assert.match(await page.locator('#notice').textContent(), /changed|edit/i)
  await run(page, 'undo')
  assert.equal((await run(page, 'state')).photos.find((photo) => photo.id === first).edit.Exposure ?? 0, 0)
  await run(page, 'redo')
  assert.equal((await run(page, 'state')).photos.find((photo) => photo.id === first).edit.Exposure, 2)
})

test('XMP read failures are visible and retryable while valid GUI and guarded CLI application preserve metadata, undo and originals', async (t) => {
  const { page, first, second, xml } = await workspace(t)
  const before = (await run(page, 'state')).photos.map(content)
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await controlledRead(page, true)
  await chooseXmp(page, xml)
  await page.waitForFunction(() => window.xmpReadStarted)
  await finishRead(page)
  assert.match(await page.locator('#notice').textContent(), /Generated XMP read failure/)
  assert.deepEqual((await run(page, 'state')).photos.map(content), before)
  assert.deepEqual(pageErrors, [], 'The GUI handles read rejection rather than leaking an unhandled promise')
  await chooseXmp(page, xml)
  await page.waitForFunction(() => document.querySelector('#xmp-file').value === '')
  const applied = (await run(page, 'state')).photos.find((photo) => photo.id === first)
  assert.equal(applied.edit.Exposure, 1.25)
  assert.equal(applied.rating, 4)
  assert.equal(applied.flag, 'pick')
  assert.equal(applied.keywords, 'generated, 青色')
  await run(page, 'undo')
  assert.deepEqual(
    (await run(page, 'state')).photos.find((photo) => photo.id === first).edit,
    before.find((photo) => photo.id === first).edit
  )
  await run(page, 'redo')
  assert.equal((await run(page, 'state')).photos.find((photo) => photo.id === first).edit.Exposure, 1.25)
  await run(page, 'select', { id: second })
  const guardedBefore = (await run(page, 'state')).photos.map(content)
  await assert.rejects(() => run(page, 'apply-xmp', { xml, photoId: first }), /changed|selected/i)
  assert.deepEqual((await run(page, 'state')).photos.map(content), guardedBefore)
  await run(page, 'apply-xmp', { xml, photoId: second })
  assert.equal((await run(page, 'state')).photos.find((photo) => photo.id === second).edit.Exposure, 1.25)
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
    )
  )
  assert.deepEqual(bytes, Array.from(original))
})
