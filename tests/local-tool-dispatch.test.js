import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'

test('GUI local-tool activation shares crop/compare transitions, observable state and pointer editing with the dispatcher', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  const input = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 100
    canvas.height = 80
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#647b91'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve))
    await window.openlr.run('import', { files: [new File([blob], 'local-tool.png', { type: 'image/png' })] })
    await window.openlr.run('view', { mode: 'detail' })
    window.localToolEvents = 0
    window.addEventListener('openlr-change', () => window.localToolEvents++)
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  const run = (command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
  for (const scenario of ['crop-tool', 'compare']) {
    await run('local-tool', { tool: 'off' })
    const initial = await run(scenario)
    assert.equal(scenario === 'crop-tool' ? initial.cropping : initial.compare, true)
    await run('panel', { name: 'Masks & local repair', open: true })
    const before = await run('state'),
      previousCount = before.photos[0].edit.localTools?.masks.length ?? 0
    await page.evaluate(() => {
      window.localToolEvents = 0
    })
    await page.getByLabel('Local tool', { exact: true }).selectOption('brush')
    const activated = await run('state'),
      summary = await run('state', { summary: true })
    assert.equal(activated.localTool, 'brush')
    assert.equal(summary.localTool, 'brush')
    assert.equal(activated.cropping, false)
    assert.equal(activated.compare, false)
    assert.equal(activated.pair, false)
    assert.equal(activated.sampling, false)
    assert.deepEqual(activated.localSelection, { id: '', path: [], overlay: true })
    assert.deepEqual(
      activated.photos[0].edit,
      before.photos[0].edit,
      scenario + ': activation is not an edit'
    )
    assert.equal(
      await page.evaluate(() => window.localToolEvents),
      1,
      'Exactly one dispatcher change notification'
    )
    assert.equal(await page.locator('.local-overlay').count(), 1)
    assert.equal(await page.locator('#stage').evaluate((el) => el.classList.contains('cropping')), false)
    const bounds = await page.locator('#stage canvas').boundingBox()
    await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.4)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width * 0.65, bounds.y + bounds.height * 0.55, { steps: 5 })
    await page.mouse.up()
    await waitForAsyncFunction(
      page,
      async (count) => {
        const state = await window.openlr.run('state')
        return state.photos[0].edit.localTools?.masks.length === count
      },
      previousCount + 1
    )
    const after = await run('state'),
      added = after.photos[0].edit.localTools.masks.at(-1)
    assert.equal(added.type, 'brush')
    assert.ok(added.points.length >= 2)
    assert.equal(after.localTool, 'brush')
    const { localTools, ...unchanged } = after.photos[0].edit,
      { localTools: beforeLocal, ...beforeUnchanged } = before.photos[0].edit
    assert.deepEqual(unchanged, beforeUnchanged)
    assert.deepEqual(localTools.masks.slice(0, -1), beforeLocal?.masks ?? [])
    const original = await page.evaluate(async () =>
      Array.from(
        new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
      )
    )
    assert.deepEqual(original, input)
  }
  await run('local-tool', { tool: 'clone' })
  assert.equal(await page.getByLabel('Local tool', { exact: true }).inputValue(), 'clone')
  assert.equal((await run('state')).localTool, 'clone')
  await run('view', { mode: 'grid' })
  assert.equal(
    (await run('state', { summary: true })).localTool,
    'clone',
    'Selected tool does not imply a mounted editing surface'
  )
  await run('local-tool', { tool: 'brush' })
  const beforeOff = await run('state')
  await page.evaluate(() => {
    window.localToolEvents = 0
  })
  await page.getByLabel('Local tool', { exact: true }).selectOption('off')
  const off = await run('state')
  assert.equal(off.localTool, 'off')
  assert.equal((await run('state', { summary: true })).localTool, 'off')
  assert.equal(await page.getByLabel('Local tool', { exact: true }).inputValue(), 'off')
  assert.equal(await page.evaluate(() => window.localToolEvents), 1)
  assert.deepEqual(off.photos[0].edit, beforeOff.photos[0].edit)
  assert.equal(await page.locator('#stage canvas').evaluate((el) => el.style.cursor), 'zoom-in')
})
