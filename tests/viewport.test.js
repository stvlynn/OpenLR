import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'
import { parse } from '../cli/openlr.mjs'

test('detail viewport CLI shares actual scrolling and preserves image/edit state', async (t) => {
  assert.equal(parse(['cli', 'search', 'viewport']).local[0].command, 'viewport')
  assert.equal(parse(['viewport', '--x', '42', '--dry-run']).args.x, 42)
  assert.throws(() => parse(['viewport', '--y', '-1']), /between|range/)
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  await page.goto(server.url)
  const pixels = new Uint8Array(1800 * 1200 * 3).fill(130)
  await page.locator('#files').setInputFiles({
    name: 'viewport.png',
    mimeType: 'image/png',
    buffer: Buffer.from(makePng({ width: 1800, height: 1200, bits: 8, colorType: 2, srgb: 0, data: pixels }))
  })
  const run = (c, a = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [c, a])
  await run('view', { mode: 'detail' })
  await run('zoom')
  const before = await run('state'),
    id = before.selected
  const bounds = await run('viewport')
  assert.ok(bounds.maxX > 100 && bounds.maxY > 100, JSON.stringify(bounds))
  const moved = await run('viewport', { x: 100, y: 80, photoId: id })
  assert.equal(moved.x, 100)
  assert.equal(moved.y, 80)
  assert.deepEqual((await run('state', { summary: true })).viewport, moved)
  const clamp = await run('viewport', { x: 1e6 })
  assert.equal(clamp.x, clamp.maxX)
  assert.equal(clamp.y, 80)
  await assert.rejects(run('viewport', { x: 0, photoId: 'stale' }), /selected photo changed/)
  assert.equal((await run('viewport')).x, clamp.x)
  await run('viewport', { x: 0, y: 0 })
  await page.evaluate(() => {
    window.viewportEvents = 0
    window.addEventListener('openlr-change', () => window.viewportEvents++)
  })
  await page.locator('#stage').hover()
  await page.mouse.wheel(0, 160)
  await page.waitForFunction(
    () => document.getElementById('stage').scrollTop > 0 && window.viewportEvents > 0
  )
  const scrolled = await run('viewport')
  assert.ok(scrolled.y > 0)
  assert.equal(scrolled.y, await page.locator('#stage').evaluate((el) => el.scrollTop))
  assert.deepEqual(
    (await run('state')).photos.find((p) => p.id === id).edit,
    before.photos.find((p) => p.id === id).edit
  )
  await run('zoom')
  const fit = await run('viewport', { x: 1e6, y: 1e6 })
  assert.equal(fit.x, fit.maxX)
  assert.equal(fit.y, fit.maxY)
  await run('view', { mode: 'grid' })
  assert.equal((await run('state')).viewport, null)
  await assert.rejects(run('viewport', { x: 0 }), /detail view/)
})
