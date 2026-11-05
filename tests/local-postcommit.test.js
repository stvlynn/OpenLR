import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('local creation publishes the same selected repair and finished AI tool before GUI and CLI notifications', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page
    .locator('#files')
    .setInputFiles({
      name: 'astronaut.png',
      mimeType: 'image/png',
      buffer: await readFile(new URL('./fixtures/ai/astronaut.png', import.meta.url))
    })
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 1)
  const run = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.openlr.run(command, args), { command, args })
  await run('local-tool', { tool: 'clone' })
  await run('mask-overlay', { enabled: false })
  await page.evaluate(() => {
    window.localEvents = []
    window.addEventListener('openlr-change', () =>
      window.localEvents.push({
        id: document.querySelector('[aria-label="Local edit selection"]').value,
        mode: document.querySelector('[aria-label="Local tool"]').value
      })
    )
  })
  const repair = {
    type: 'clone',
    source: { x: 0.2, y: 0.3 },
    points: [{ x: 0.7, y: 0.6 }],
    radius: 0.03,
    feather: 0.5
  }
  const result = await run('repair.add', { repair })
  const photo = result.photos.find((p) => p.id === result.selected)
  const id = photo.edit.localTools.repairs.at(-1).id
  assert.equal(result.localSelection.id, id)
  assert.equal(result.localSelection.overlay, false)
  assert.deepEqual(await page.evaluate(() => window.localEvents.at(-1)), { id, mode: 'clone' })
  await run('repair-source', { point: repair.source })
  const box = await page.locator('#stage canvas').boundingBox()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.6)
  await page.mouse.up()
  const drawn = await run('state')
  const drawnId = drawn.photos.find((p) => p.id === drawn.selected).edit.localTools.repairs.at(-1).id
  assert.notEqual(drawnId, id)
  assert.equal(drawn.localSelection.id, drawnId)
  assert.equal(drawn.localSelection.overlay, false)
  assert.deepEqual(await page.evaluate(() => window.localEvents.at(-1)), { id: drawnId, mode: 'clone' })
  for (const entry of ['cli', 'gui']) {
    await run('local-tool', { tool: 'brush' })
    if (entry === 'cli') await run('ai-mask', { target: 'person', adjustments: {} })
    else {
      await page.getByLabel('AI mask target', { exact: true }).selectOption('person')
      await page.getByRole('button', { name: 'Generate AI mask', exact: true }).click()
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll('button')].find(
            (button) => button.textContent === 'Generate AI mask'
          ).disabled
      )
    }
    const state = await run('state')
    const maskId = state.photos.find((p) => p.id === state.selected).edit.localTools.masks.at(-1).id
    assert.equal(state.localTool, 'off', entry)
    assert.equal(state.localSelection.id, maskId)
    assert.equal(state.localSelection.overlay, true)
    assert.deepEqual(await page.evaluate(() => window.localEvents.at(-1)), { id: maskId, mode: 'off' })
    assert.equal(await page.locator('.local-tools').evaluate((node) => node.open), true)
    assert.equal(await page.locator('#stage canvas').evaluate((node) => node.style.cursor), 'zoom-in')
  }
})
