import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'

const colors = [
  [64, 96, 128],
  [176, 64, 32],
  [32, 96, 176],
  [128, 160, 48]
]
const pixels = new Uint8Array(80 * 60 * 3)
for (let y = 0; y < 60; y++)
  for (let x = 0; x < 80; x++) pixels.set(colors[(y >= 30 ? 2 : 0) + (x >= 40 ? 1 : 0)], (y * 80 + x) * 3)
const original = Buffer.from(makePng({ width: 80, height: 60, bits: 8, colorType: 2, srgb: 0, data: pixels }))
const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
const active = (state) => state.photos.find((photo) => photo.id === state.selected)

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page
    .locator('#files')
    .setInputFiles({ name: 'range-source.png', mimeType: 'image/png', buffer: original })
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 1)
  await run(page, 'view', { mode: 'detail' })
  return page
}

async function pointerSample(page, point = { x: 0.25, y: 0.25 }) {
  const bounds = await page.locator('#stage canvas').boundingBox()
  assert.ok(bounds && bounds.width > 0)
  await page.mouse.click(bounds.x + bounds.width * point.x, bounds.y + bounds.height * point.y)
  await waitForAsyncFunction(page, async () => (await window.openlr.run('state')).localTool === 'off')
}

test('range sampler activation exits incompatible tools and pointer sampling shares original-color CLI in both versions', async (t) => {
  const page = await workspace(t)
  for (const version of [1, 2]) {
    await run(page, 'processing', { version })
    await run(page, 'edit', { key: 'Exposure', value: 1 })
    assert.notEqual((await run(page, 'sample-color', { x: 0.25, y: 0.25 })).color, '#406080')
    for (const incompatible of ['crop-tool', 'compare', 'compare-pair', 'sample-tool']) {
      await run(page, incompatible)
      await run(page, 'panel', { name: 'Masks & local repair', open: true })
      const before = await run(page, 'state')
      await page.getByRole('button', { name: 'Sample range color', exact: true }).click()
      const enabled = await run(page, 'state')
      assert.equal(enabled.localTool, 'color-sample')
      assert.equal((await run(page, 'state', { summary: true })).localTool, 'color-sample')
      for (const flag of ['cropping', 'compare', 'pair', 'sampling']) assert.equal(enabled[flag], false, flag)
      assert.equal(await page.locator('.local-overlay').count(), 1)
      assert.deepEqual(active(enabled).edit, active(before).edit)
      await pointerSample(page)
      const after = await run(page, 'state')
      assert.equal(after.rangeColor, '#406080')
      assert.equal((await run(page, 'state', { summary: true })).rangeColor, '#406080')
      assert.equal(await page.getByLabel('Range color', { exact: true }).inputValue(), '#406080')
      assert.deepEqual(active(after).edit, active(before).edit, 'Draft sampling does not edit a photograph')
      assert.deepEqual(await run(page, 'range-color', { x: 0.25, y: 0.25, id: '', path: [] }), {
        color: '#406080'
      })
    }
  }
  const state = await run(page, 'state')
  await run(page, 'local-tool', { tool: 'color-sample', photoId: state.selected })
  await run(page, 'local-tool', { tool: 'brush' })
  assert.equal((await run(page, 'state')).localTool, 'brush')
  await assert.rejects(
    () => run(page, 'range-color', { x: 0.25, y: 0.25, photoId: 'stale-photo' }),
    /changed|selected/i
  )
  assert.deepEqual(active(await run(page, 'state')).edit, active(state).edit)
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
    )
  )
  assert.deepEqual(bytes, Array.from(original))
})

test('range pointer reverses crop, turn, flip and optics before sampling the immutable original surface', async (t) => {
  const page = await workspace(t)
  await run(page, 'edit', { key: 'crop', value: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } })
  await run(page, 'edit', { key: 'flip', value: true })
  await run(page, 'optics', { changes: { vertical: 8, horizontal: -5, rotate: 3, scale: 110 } })
  await run(page, 'edit', { key: 'Exposure', value: 1 })
  for (const version of [1, 2]) {
    await run(page, 'processing', { version })
    for (const turn of [0, 1, 2, 3]) {
      await run(page, 'edit', { key: 'turn', value: turn })
      const before = await run(page, 'state')
      const view = await page.evaluate(async () => {
        const { originalToView } = await import('./local-tools-ui.js')
        const state = await window.openlr.run('state'),
          photo = state.photos.find((photo) => photo.id === state.selected)
        return originalToView({ x: 0.25, y: 0.25 }, { width: 80, height: 60 }, photo.edit)
      })
      assert.ok(view.x > 0 && view.x < 1 && view.y > 0 && view.y < 1)
      await run(page, 'local-tool', { tool: 'color-sample' })
      await pointerSample(page, view)
      assert.equal((await run(page, 'state')).rangeColor, '#406080', `version ${version}, turn ${turn}`)
      assert.deepEqual(active(await run(page, 'state')).edit, active(before).edit)
    }
  }
})

test('selected nested color range sampling updates one component through undo/persistence while explicit draft stays separate', async (t) => {
  const page = await workspace(t)
  const mask = {
    type: 'color-range',
    color: '#808080',
    tolerance: 0.05,
    softness: 0.1,
    adjustments: { Exposure: 0.5 }
  }
  await run(page, 'mask.add', { mask })
  const first = active(await run(page, 'state')).edit.localTools.masks[0].id
  await run(page, 'mask.add', { mask: { ...mask, color: '#909090' } })
  const second = active(await run(page, 'state')).edit.localTools.masks[1].id
  await run(page, 'mask.combine', { id: first, operandId: second, operation: 'add' })
  await run(page, 'local-select', { id: first, path: [1] })
  const before = await run(page, 'state')
  await run(page, 'crop-tool')
  await run(page, 'panel', { name: 'Masks & local repair', open: true })
  await page.getByRole('button', { name: 'Sample range color', exact: true }).click()
  assert.deepEqual((await run(page, 'state')).localSelection.path, [1])
  await pointerSample(page)
  let after = await run(page, 'state')
  const components = active(after).edit.localTools.masks[0].components
  assert.equal(components[1].color, '#406080')
  assert.deepEqual(components[0], active(before).edit.localTools.masks[0].components[0])
  await run(page, 'undo')
  assert.deepEqual(active(await run(page, 'state')).edit, active(before).edit)
  await run(page, 'redo')
  after = await run(page, 'state')
  await run(page, 'range-color', { x: 0.75, y: 0.25, id: '', path: [] })
  assert.equal((await run(page, 'state')).rangeColor, '#b04020')
  assert.deepEqual(active(await run(page, 'state')).edit, active(after).edit)
  await assert.rejects(
    () => run(page, 'range-color', { x: 0.25, y: 0.25, id: 'missing-mask', path: [] }),
    /not found|mask|selection/i
  )
  await assert.rejects(
    () => run(page, 'range-color', { x: 0.25, y: 0.25, id: first, path: [1, 0] }),
    /component|path|mask/i
  )
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  assert.deepEqual(active(await run(page, 'state')).edit, active(after).edit)
})
