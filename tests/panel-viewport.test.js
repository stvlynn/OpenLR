import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { parse } from '../cli/openlr.mjs'
import { readPng } from '../web/png.js'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'
import { holdCatalogThumbnail } from './catalog-thumbnail-hold.mjs'

const frame = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

async function panelPixels(page, port) {
  const { x, y, width, height } = await port.boundingBox()
  return readPng(await page.screenshot({ clip: { x, y, width, height }, animations: 'disabled' }))
}

function panelRasterDiff(actual, expected) {
  const { width, height, data } = actual
  assert.deepEqual([width, height], [expected.width, expected.height])
  let maxDifference = 0,
    count = 0,
    left = width,
    right = -1,
    top = height,
    bottom = -1
  for (let offset = 0; offset < data.length; offset += 4) {
    let difference = 0
    for (let channel = 0; channel < 4; channel++) {
      const index = offset + channel
      const actualByte = Math.round(data[index] * 255)
      const expectedByte = Math.round(expected.data[index] * 255)
      difference = Math.max(difference, Math.abs(actualByte - expectedByte))
    }
    maxDifference = Math.max(maxDifference, difference)
    if (difference <= 1) continue
    const pixel = offset / 4,
      x = pixel % width,
      y = Math.floor(pixel / width)
    count++
    left = Math.min(left, x)
    right = Math.max(right, x)
    top = Math.min(top, y)
    bottom = Math.max(bottom, y)
  }
  return { maxDifference, count, bounds: count ? { left, top, right, bottom } : null }
}

test(
  'Photos and Inspector viewports reproduce trusted scrolling, captured panels and ordered state',
  { timeout: 60_000 },
  async (t) => {
    for (const target of ['photos', 'inspector']) {
      assert.deepEqual(parse(['viewport', '--target', target, '--y', '42', '--dry-run']).args, {
        target,
        y: 42
      })
    }
    const server = await serveWorkspace()
    t.after(server.close)
    const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
    t.after(() => browser.close())
    t.diagnostic('Chrome ' + browser.version())
    const page = await browser.newPage({ viewport: { width: 1280, height: 620 } })
    await page.goto(server.url)
    await page.waitForFunction(() => window.openlr)
    const run = (command, args = {}) =>
      page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args])
    const state = (summary = false) => run('state', { summary })
    const move = (target, args) => run('viewport', { target, ...args })
    const nav = page.locator('main > nav')
    const inspector = page.locator('main > aside')
    const empty = await move('photos', { y: 900 })
    assert.ok(empty.height > 0)
    assert.equal(empty.y, 0)
    assert.equal(empty.maxY, 0)
    assert.deepEqual((await state(true)).panelViewports, { photos: empty, inspector: null })
    await assert.rejects(move('inspector'), /show the Inspector/i)

    const width = 64,
      height = 48
    const files = [80, 140].map((byte, i) => ({
      name: `panel-viewport-${i}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(
        makePng({
          width,
          height,
          bits: 8,
          colorType: 2,
          data: new Uint8Array(width * height * 3).fill(byte)
        })
      )
    }))
    await page.locator('#files').setInputFiles(files)
    await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)
    const { photos } = await state()
    const [first, second] = files.map(({ name }) => photos.find((photo) => photo.name === name))
    const albums = await page.evaluate(async () => {
      const created = []
      for (let i = 0; i < 32; i++)
        created.push(
          await window.openlr.run('album', { name: 'Generated album ' + String(i).padStart(2, '0') })
        )
      return created
    })
    await run('select', { id: second.id })
    await run('flag', { value: 'pick' })
    await run('select', { id: first.id })
    const editBefore = (await run('edit', { key: 'Exposure', value: 0.25 })).photos.find(
      ({ id }) => id === first.id
    ).edit
    await page.evaluate(() => {
      window.panelViewportEvents = []
      window.addEventListener('openlr-change', () =>
        window.panelViewportEvents.push(window.openlr.run('state', { summary: true }))
      )
    })
    const resetEvents = async () => {
      await frame(page)
      await page.evaluate(() => {
        window.panelViewportEvents.length = 0
      })
    }
    const events = () => page.evaluate(() => Promise.all(window.panelViewportEvents))
    const watch = async () => {
      await page.waitForFunction(() => window.panelViewportEvents.length > 0)
      await frame(page)
      return events()
    }
    const inPort = (button) =>
      button.evaluate((node) => {
        const port = node.closest('nav, aside').getBoundingClientRect()
        const rect = node.getBoundingClientRect()
        return rect.height > 0 && rect.top >= port.top && rect.bottom <= port.bottom
      })
    async function compareScroll(target, port, distance) {
      const before = await move(target)
      const beforePixels = await panelPixels(page, port)
      await port.hover({ position: { x: 25, y: 50 } })
      await resetEvents()
      await page.mouse.wheel(0, distance)
      const wheelEvents = await watch()
      const scrolled = await move(target)
      assert.ok(scrolled.y > before.y)
      assert.equal(scrolled.y, await port.evaluate((element) => element.scrollTop))
      assert.deepEqual(wheelEvents.at(-1).panelViewports[target], scrolled)
      await page.mouse.move(1, 1)
      const trustedPixels = await panelPixels(page, port)
      assert.ok(
        panelRasterDiff(trustedPixels, beforePixels).count > 0,
        `${target} wheel must change panel pixels`
      )
      assert.deepEqual(await move(target, { y: before.y }), before)
      await resetEvents()
      assert.deepEqual(await move(target, { y: scrolled.y, photoId: first.id }), scrolled)
      assert.deepEqual(
        (await watch()).map((value) => value.panelViewports[target]),
        [scrolled]
      )
      const difference = panelRasterDiff(await panelPixels(page, port), trustedPixels)
      t.diagnostic(JSON.stringify({ target, ...difference }))
      assert.equal(
        difference.count,
        0,
        `${target} panel raster exceeds one 8-bit level ${JSON.stringify(difference)}`
      )
      assert.deepEqual((await state()).panelViewports[target], scrolled)
      assert.deepEqual((await state(true)).panelViewports[target], scrolled)

      await resetEvents()
      assert.deepEqual(await move(target), scrolled)
      assert.deepEqual(await move(target, { y: scrolled.y }), scrolled)
      await frame(page)
      assert.deepEqual(await events(), [])
      const endpoint = await move(target, { y: 1e6 })
      assert.ok(Math.abs(endpoint.y - endpoint.maxY) <= 1)
      assert.ok(endpoint.y > scrolled.y)
      return scrolled
    }

    assert.equal((await state()).mode, 'grid')
    await compareScroll('photos', nav, 730)
    const lastAlbum = page.getByRole('button', { name: albums.at(-1).name })
    assert.equal(await inPort(lastAlbum), true)
    await move('photos', { y: 0 })
    await run('scope', { id: albums.at(-1).id })
    assert.equal((await move('photos')).y, 0, 'scope does not change sidebar scroll')
    assert.equal(await inPort(lastAlbum), false)
    await run('panel', { name: 'photos', open: false })
    assert.equal((await state(true)).panelViewports.photos, null)
    await assert.rejects(move('photos', { y: 0 }), /show the Photos panel/i)
    await run('panel', { name: 'photos', open: true })
    assert.ok((await state(true)).panelViewports.photos)

    await run('scope', { id: 'all' })
    await run('select', { id: first.id })
    await run('view', { mode: 'detail', inspector: false })
    await assert.rejects(move('inspector', { y: 200 }), /show the Inspector/i)
    const shown = await run('panel', { name: 'Masks & local repair', open: true })
    assert.equal(shown.panels['Masks & local repair'], true)
    assert.ok(shown.panelViewports.inspector.y > 0, 'panel still scrolls the section into view')
    const control = page.getByRole('button', { name: 'Create color range' })
    assert.equal(await inPort(control), false)
    const inspected = await compareScroll('inspector', inspector, 340)
    await move('inspector', { y: inspected.y })
    assert.equal(await inPort(control), true)
    const kept = await run('panel', { name: 'Masks & local repair', open: true })
    assert.deepEqual(
      kept.panelViewports.inspector,
      inspected,
      'nearest panel alignment preserves this interior offset'
    )
    assert.equal(kept.selected, first.id)
    assert.deepEqual(kept.photos.find(({ id }) => id === first.id).edit, editBefore)

    await run('slideshow', { seconds: 3600 })
    assert.deepEqual((await state(true)).panelViewports, { photos: null, inspector: null })
    await assert.rejects(move('photos'), /show the Photos panel/i)
    await assert.rejects(move('inspector'), /show the Inspector/i)
    await run('slideshow', { stop: true })
    assert.ok((await move('photos')).height > 0)
    assert.ok((await move('inspector')).height > 0)

    await holdCatalogThumbnail(page)
    await page.evaluate((photoId) => {
      window.pendingPanelEdit = window.openlr.run('edit', { key: 'Contrast', value: 8, photoId })
    }, first.id)
    await page.waitForFunction(() => typeof window.catalogThumbnailHold.release === 'function')
    await page.evaluate((photoId) => {
      const { run, dispatch } = window.openlr
      window.pendingPanelMoves = Promise.all([
        run('scope', { id: 'picked' }),
        dispatch('viewport', { target: 'photos', photoId, y: 100 }),
        dispatch('viewport', { target: 'inspector', y: 100 }),
        run('viewport', { target: 'photos', y: 1e6 })
      ])
    }, first.id)
    const [scoped, stale, hidden, finalPhotos] = await page.evaluate(async () => {
      window.catalogThumbnailHold.release()
      await window.pendingPanelEdit
      return window.pendingPanelMoves
    })
    assert.equal(scoped.selected, second.id)
    assert.equal(scoped.scope, 'picked')
    assert.equal(stale.ok, false)
    assert.match(stale.error.message, /selected photo changed/i)
    assert.equal(hidden.ok, false)
    assert.match(hidden.error.message, /show the Inspector/i)
    assert.ok(Math.abs(finalPhotos.y - finalPhotos.maxY) <= 1)
    assert.deepEqual((await state(true)).panelViewports, { photos: finalPhotos, inspector: null })
    assert.deepEqual((await state()).photos[0].edit, second.edit)

    await run('scope', { id: 'all' })
    await run('select', { id: first.id })
    const original = await page.evaluate(() => window.openlr.dispatch('export', { format: 'original' }))
    assert.equal(original.ok, true, original.error?.message)
    assert.deepEqual(Buffer.from(original.result.base64, 'base64'), files[0].buffer)
    assert.deepEqual((await state()).photos.find(({ id }) => id === first.id).edit, {
      ...editBefore,
      Contrast: 8
    })
    await run('delete')
    await run('scope', { id: 'trash' })
    await run('view', { mode: 'detail' })
    assert.equal((await state(true)).panelViewports.inspector, null, 'deleted photo Inspector stays hidden')
    await assert.rejects(move('inspector'), /show the Inspector/i)
  }
)
