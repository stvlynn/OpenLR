import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'

test('Grid navigation and Escape stop the same slideshow session', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  await page.clock.install()
  await page.goto(server.url)
  await page.locator('#files').setInputFiles(
    [64, 192].map((shade) => ({
      name: `slide-${shade}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(
        makePng({
          width: 24,
          height: 16,
          bits: 8,
          colorType: 2,
          data: new Uint8Array(24 * 16 * 3).fill(shade)
        })
      )
    }))
  )
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)

  const dispatch = async (command, args = {}) => {
    const reply = await page.evaluate(
      ([command, args]) => window.openlr.dispatch(command, args),
      [command, args]
    )
    assert.equal(reply.ok, true, reply.error?.message)
    return reply.result
  }
  await dispatch('edit', { key: 'Exposure', value: 0.5 })
  const original = await dispatch('state')
  const recipes = (state) => Object.fromEntries(state.photos.map(({ id, edit }) => [id, edit]))
  const assertGrid = async (state) => {
    assert.equal(state.mode, 'grid')
    assert.equal(state.slideshow, false)
    assert.equal(await page.locator('nav').isVisible(), true)
    assert.equal(await page.locator('#gallery').isVisible(), true)
    assert.equal(await page.locator('#end-slides').isVisible(), false)
  }

  const started = await dispatch('slideshow', { seconds: 60 })
  assert.equal(started.slideshow, true)
  assert.equal(await page.locator('#end-slides').isVisible(), true)
  assert.equal(await page.locator('#stage canvas').isVisible(), true)
  const navigated = await dispatch('view', { mode: 'grid' })
  await assertGrid(navigated)
  await page.clock.fastForward(60_000)
  assert.equal((await dispatch('state')).selected, navigated.selected)

  await page.locator('#photo-menu summary').click()
  await page.getByRole('button', { name: 'Start slideshow', exact: true }).click()
  const restarted = await dispatch('state')
  assert.equal(restarted.slideshow, true)
  assert.equal(restarted.mode, 'detail')
  await page.clock.fastForward(3_000)
  assert.notEqual((await dispatch('state')).selected, restarted.selected)

  await page.keyboard.press('Escape')
  const escaped = await dispatch('state')
  await assertGrid(escaped)
  await page.clock.fastForward(3_000)
  const finished = await dispatch('state')
  assert.equal(finished.selected, escaped.selected)
  assert.deepEqual(recipes(finished), recipes(original))

  for (const [command, args] of [
    ['grid-layout', { layout: 'mosaic' }],
    ['scope', { id: 'all' }],
    ['search', { text: 'no matching photograph' }]
  ]) {
    await dispatch('slideshow', { seconds: 60 })
    const grid = await dispatch(command, args)
    await assertGrid(grid)
    await page.clock.fastForward(60_000)
    const after = await dispatch('state')
    assert.equal(after.selected, grid.selected)
    assert.equal(after.slideshow, false)
  }
  await dispatch('search', { text: '' })
  assert.deepEqual(recipes(await dispatch('state')), recipes(original))
})
