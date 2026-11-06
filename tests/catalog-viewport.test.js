import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { parse } from '../cli/openlr.mjs'
import { readPng } from '../web/png.js'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'

const colors = [
  [233, 42, 55],
  [42, 203, 82],
  [44, 95, 229],
  [233, 154, 32]
]
const name = (i) => 'viewport-' + String(i).padStart(2, '0') + '.png'
const frame = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

async function visibleTilePixels(page, selector, first) {
  const clip = await waitForAsyncFunction(
    page,
    ([selector, first]) => {
      const port = document.querySelector(selector)
      const { left, top, right, bottom } = port.getBoundingClientRect()
      const tile = [...port.querySelectorAll('.tile')].find((tile) => {
        const index = Number(tile.querySelector('span').textContent.slice(9, 11))
        if (index < first || index >= first + 12) return false
        const img = tile.querySelector('img')
        const rect = img.getBoundingClientRect()
        return (
          img.complete &&
          img.naturalWidth &&
          rect.left >= left &&
          rect.top >= top &&
          rect.right <= right &&
          rect.bottom <= bottom
        )
      })
      if (!tile) return null
      const { x, y, width, height } = tile.querySelector('img').getBoundingClientRect()
      return { x: Math.floor(x + width / 2) - 4, y: Math.floor(y + height / 2) - 4, width: 8, height: 8 }
    },
    [selector, first]
  )
  const { data } = readPng(await page.screenshot({ clip }))
  const expected = colors[first / 12]
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(data[i + c] * 255 - expected[c]) <= 4)
    assert.equal(data[i + 3], 1)
  }
  return { clip, data }
}

test(
  'Grid and Filmstrip viewport commands share the visible scrollports, pixels and watch state',
  { timeout: 60_000 },
  async (t) => {
    assert.deepEqual(parse(['viewport', '--target', 'filmstrip', '--x', '42', '--dry-run']).args, {
      target: 'filmstrip',
      x: 42
    })
    assert.throws(() => parse(['viewport', '--target', 'catalog']), /target/)
    const server = await serveWorkspace()
    t.after(server.close)
    const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
    t.after(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 960, height: 660 } })
    await page.goto(server.url)
    const run = (command, args = {}) =>
      page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args])
    const viewport = (target, args) => run('viewport', { target, ...args })
    const state = (summary = false) => run('state', { summary })
    const empty = await viewport('grid', { y: 900 })
    assert.equal(empty.y, 0)
    assert.equal(empty.maxY, 0)
    assert.ok(empty.height > 0)
    assert.deepEqual((await state(true)).catalogViewports, { grid: empty, filmstrip: null })

    const width = 40,
      height = 30
    const files = Array.from({ length: 48 }, (_, i) => {
      const data = new Uint8Array(width * height * 3)
      for (let offset = 0; offset < data.length; offset += 3) data.set(colors[Math.floor(i / 12)], offset)
      return {
        name: name(i),
        mimeType: 'image/png',
        buffer: Buffer.from(makePng({ width, height, bits: 8, colorType: 2, data }))
      }
    })
    await page.locator('#files').setInputFiles(files)
    await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 48)
    await run('sort', { order: 'name' })
    const photos = (await state()).photos
    const first = photos[0]
    await run('select', { id: first.id })
    await frame(page)
    await page.evaluate(() => {
      window.catalogViewportChanges = []
      window.addEventListener('openlr-change', () => {
        window.catalogViewportChanges.push(window.openlr.run('state', { summary: true }))
      })
    })
    const resetEvents = async () => {
      await frame(page)
      await page.evaluate(() => {
        window.catalogViewportChanges.length = 0
      })
    }
    const events = () => page.evaluate(() => Promise.all(window.catalogViewportChanges))
    const watch = async () => {
      await page.waitForFunction(() => window.catalogViewportChanges.length)
      await frame(page)
      return events()
    }
    async function compareScroll(target, selector, axis, distance) {
      await visibleTilePixels(page, selector, 0)
      await page.locator(selector).hover()
      await resetEvents()
      await page.mouse.wheel(axis === 'x' ? distance : 0, axis === 'y' ? distance : 0)
      const trusted = await viewport(target)
      const watchedWheel = await watch()
      const scrolled = await viewport(target)
      assert.ok(scrolled[axis] > 0)
      assert.ok(scrolled[axis] >= trusted[axis])
      assert.equal(
        scrolled[axis],
        await page
          .locator(selector)
          .evaluate((port, axis) => (axis === 'x' ? port.scrollLeft : port.scrollTop), axis)
      )
      assert.deepEqual(watchedWheel.at(-1).catalogViewports[target], scrolled)
      const userPixels = await visibleTilePixels(page, selector, 12)

      await viewport(target, { [axis]: 0 })
      await resetEvents()
      const actual = await viewport(target, { [axis]: scrolled[axis], photoId: first.id })
      assert.deepEqual(actual, scrolled)
      assert.deepEqual(
        (await watch()).map((value) => value.catalogViewports[target]),
        [actual]
      )
      assert.deepEqual((await state()).catalogViewports[target], actual)
      assert.deepEqual((await state(true)).catalogViewports[target], actual)
      assert.deepEqual(await visibleTilePixels(page, selector, 12), userPixels)

      await resetEvents()
      assert.deepEqual(await viewport(target), actual)
      assert.deepEqual(await viewport(target, { [axis]: actual[axis] }), actual)
      await frame(page)
      assert.deepEqual(await events(), [])
      await assert.rejects(
        viewport(target, { [axis]: 0, photoId: photos.at(-1).id }),
        /selected photo changed/i
      )
      assert.deepEqual(await viewport(target), actual)
      const max = await viewport(target, { [axis]: 1e6 })
      const maxAxis = axis === 'x' ? 'maxX' : 'maxY'
      assert.ok(Math.abs(max[axis] - max[maxAxis]) <= 1)
      assert.ok(max[axis] > actual[axis])
      assert.equal((await state()).selected, first.id)
    }

    assert.equal((await state()).viewport, null)
    await assert.rejects(run('viewport'), /detail view/i)
    await assert.rejects(viewport('filmstrip'), /show the filmstrip/i)
    await compareScroll('grid', '#gallery', 'y', 640)

    await run('view', { mode: 'detail' })
    const detail = await run('viewport')
    assert.deepEqual(await viewport('detail'), detail)
    assert.equal((await state(true)).catalogViewports.grid, null)
    await assert.rejects(viewport('grid'), /open grid view/i)
    await compareScroll('filmstrip', '#film', 'x', 1120)
    assert.deepEqual(await run('viewport'), detail)
    assert.deepEqual((await state()).photos.find(({ id }) => id === first.id).edit, first.edit)

    await run('film')
    assert.equal((await state()).catalogViewports.filmstrip, null)
    await assert.rejects(viewport('filmstrip', { x: 100 }), /show the filmstrip/i)
    await run('film')
    await run('slideshow', { seconds: 3600 })
    assert.equal((await state(true)).catalogViewports.filmstrip, null)
    await assert.rejects(viewport('filmstrip'), /show the filmstrip/i)
    await run('slideshow', { stop: true })
    assert.ok((await state()).catalogViewports.filmstrip)

    const picked = photos.at(-1)
    await run('select', { id: picked.id })
    await run('flag', { value: 'pick' })
    await run('select', { id: first.id })
    const [scoped, move, stale] = await page.evaluate(
      (photoId) =>
        Promise.all([
          window.openlr.run('scope', { id: 'picked' }),
          window.openlr.run('viewport', { target: 'grid', y: 1e6 }),
          window.openlr.dispatch('viewport', { target: 'grid', y: 90, photoId })
        ]),
      first.id
    )
    assert.equal(scoped.scope, 'picked')
    assert.equal(scoped.selected, picked.id)
    assert.equal(move.y, 0)
    assert.equal(move.maxY, 0)
    assert.equal(stale.ok, false)
    assert.match(stale.error.message, /selected photo changed/i)
    assert.deepEqual((await state(true)).catalogViewports, { grid: move, filmstrip: null })

    await run('scope', { id: 'all' })
    await run('select', { id: first.id })
    const original = await page.evaluate(() => window.openlr.dispatch('export', { format: 'original' }))
    assert.equal(original.ok, true, original.error?.message)
    assert.deepEqual(Buffer.from(original.result.base64, 'base64'), files[0].buffer)
  }
)
