import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('draw, resize, move, cancel and commit a crop using the workspace handles', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  await page.goto(server.url)
  await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 400
    c.height = 300
    c.getContext('2d').fillRect(0, 0, c.width, c.height)
    const blob = await new Promise((cb) => c.toBlob(cb))
    await window.openlr.run('import', { files: [new File([blob], 'crop.png', { type: 'image/png' })] })
  })
  await page.keyboard.press('c')
  const surface = page.locator('.crop-surface')
  await surface.waitFor()
  const canvas = await page.locator('#stage canvas').boundingBox()
  const drag = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    await page.mouse.move(x2, y2, { steps: 4 })
    await page.mouse.up()
  }
  await drag(canvas.x + 40, canvas.y + 30, canvas.x + 240, canvas.y + 210)
  const grip = await surface.locator('[data-grip=se]').boundingBox()
  await drag(grip.x + 5, grip.y + 5, grip.x + 45, grip.y + 35)
  await drag(canvas.x + 120, canvas.y + 100, canvas.x + 160, canvas.y + 120)
  await page.keyboard.press('Enter')
  await surface.waitFor({ state: 'detached' })
  const recipe = () => page.evaluate(async () => (await window.openlr.run('state')).photos[0].edit)
  const { crop } = await recipe()
  assert.ok(Math.abs(crop.x - 0.2) < 0.015 && Math.abs(crop.y - 1 / 6) < 0.015)
  assert.ok(Math.abs(crop.w - 0.6) < 0.015 && Math.abs(crop.h - 0.7) < 0.015)
  await page.keyboard.press('c')
  await surface.waitFor()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Escape')
  await surface.waitFor({ state: 'detached' })
  assert.deepEqual((await recipe()).crop, crop)
})
