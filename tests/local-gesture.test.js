import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'
import { parse } from '../cli/openlr.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'

test('local strokes cancel without committing on Escape and surface changes', async (t) => {
  assert.equal(parse(['cli', 'search', 'local-cancel']).local[0].command, 'local-cancel')
  assert.equal(parse(['local-cancel', '--photoId', 'photo', '--dry-run']).args.photoId, 'photo')
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.goto(server.url)
  await page.locator('#files').setInputFiles({
    name: 'gesture.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      makePng({
        width: 100,
        height: 80,
        bits: 8,
        colorType: 2,
        srgb: 0,
        data: new Uint8Array(100 * 80 * 3).fill(100)
      })
    )
  })
  const run = (c, a = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [c, a])
  await run('local-tool', { tool: 'brush' })
  const before = await run('state')
  await page.evaluate(() =>
    document.addEventListener(
      'pointerdown',
      (e) => {
        window.strokePointer = e.pointerId
      },
      true
    )
  )
  for (const [tool, action] of [
    ['brush', 'escape'],
    ['linear', 'escape'],
    ['radial', 'cli'],
    ['brush', 'grid'],
    ['brush', 'capture'],
    ['brush', 'pointercancel'],
    ['brush', 'mode'],
    ['brush', 'panel'],
    ['clone', 'escape'],
    ['heal', 'cli']
  ]) {
    await run('local-tool', { tool })
    const box = await page.locator('#stage canvas').boundingBox()
    if (['clone', 'heal'].includes(tool)) {
      await page.keyboard.down('Alt')
      await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2)
      await page.keyboard.up('Alt')
    }
    // Canvas pointerdown prevents focus changes: Escape must also work while
    // an inspector input retains keyboard focus.
    await page.getByLabel('Local tool', { exact: true }).focus()
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.5, { steps: 3 })
    assert.ok(
      await page.locator('.local-overlay image, .local-overlay path').count(),
      tool + ': live stroke overlay exists'
    )
    if (action === 'escape') await page.keyboard.press('Escape')
    else if (action === 'grid') await run('view', { mode: 'grid' })
    else if (action === 'cli') {
      await assert.rejects(run('local-cancel', { photoId: 'stale' }), /selected photo changed/)
      assert.deepEqual(await run('local-cancel', { photoId: before.selected }), { canceled: true })
      assert.deepEqual(await run('local-cancel'), { canceled: false })
    } else if (action === 'mode') await run('local-tool', { tool: 'linear' })
    else if (action === 'panel') await run('panel', { name: 'Masks & local repair', open: false })
    else
      await page.evaluate((action) => {
        const canvas = document.querySelector('#stage canvas')
        if (action === 'capture') canvas.releasePointerCapture(window.strokePointer)
        else canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.strokePointer }))
      }, action)
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.55)
    await page.mouse.up()
    await run('view', { mode: 'detail' })
    assert.deepEqual((await run('state')).photos[0].edit, before.photos[0].edit, action)
    assert.equal(
      await page.locator('.local-overlay image, .local-overlay path').count(),
      0,
      action + ' clears draft overlay'
    )
  }
  // Cancellation must leave the next genuine stroke usable and add no history.
  await run('local-tool', { tool: 'brush' })
  const box = await page.locator('#stage canvas').boundingBox()
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5)
  await page.mouse.up()
  await waitForAsyncFunction(
    page,
    async () => (await window.openlr.run('state')).photos[0].edit.localTools?.masks.length === 1
  )
  await run('undo')
  assert.deepEqual((await run('state')).photos[0].edit, before.photos[0].edit)
})
