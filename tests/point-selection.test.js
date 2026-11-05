import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'

const pixels = new Uint8Array(80 * 60 * 3)
for (let offset = 0; offset < pixels.length; offset += 3) pixels.set([64, 96, 128], offset)
const original = Buffer.from(makePng({ width: 80, height: 60, bits: 8, colorType: 2, srgb: 0, data: pixels }))
const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
const active = (state) => state.photos.find((photo) => photo.id === state.selected)

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page
    .locator('#files')
    .setInputFiles({ name: 'point-source.png', mimeType: 'image/png', buffer: original })
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 1)
  await run(page, 'view', { mode: 'detail' })
  await run(page, 'panel', { name: 'Point color', open: true })
  return page
}

async function expectSelection(page, id) {
  const state = await run(page, 'state')
  assert.equal(state.selectedPoint, id)
  assert.equal((await run(page, 'state', { summary: true })).selectedPoint, id)
  assert.equal(await page.getByLabel('Color sample', { exact: true }).inputValue(), id)
  return state
}

test('Point color GUI and CLI selection share state without changing recipes or consuming undo', async (t) => {
  const page = await workspace(t)
  const first = (await run(page, 'point-add', { color: '#ff0000' })).id
  const second = (await run(page, 'point-add', { color: '#0000ff' })).id
  await run(page, 'point-update', { id: second, hue: 45 })
  await expectSelection(page, second)
  const before = active(await run(page, 'state')).edit
  await page.getByLabel('Color sample', { exact: true }).selectOption(first)
  await waitForAsyncFunction(
    page,
    async (id) => (await window.openlr.run('state')).selectedPoint === id,
    first
  )
  await expectSelection(page, first)
  assert.equal(await page.getByLabel('Point hue', { exact: true }).inputValue(), '0')
  assert.deepEqual(active(await run(page, 'state')).edit, before)
  await run(page, 'point-select', { id: second })
  await expectSelection(page, second)
  assert.equal(await page.getByLabel('Point hue', { exact: true }).inputValue(), '45')
  await run(page, 'point-select', { id: first })
  await run(page, 'undo')
  await expectSelection(page, first)
  assert.equal(active(await run(page, 'state')).edit.pointColors[1].hue, 0, 'Selection adds no undo entry')
  await run(page, 'redo')
  await run(page, 'point-update', { id: second, saturation: 20 })
  await expectSelection(page, first)
  assert.equal(await page.getByLabel('Point saturation', { exact: true }).inputValue(), '0')
  await page.getByLabel('Point hue', { exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await waitForAsyncFunction(
    page,
    async (id) => {
      const state = await window.openlr.run('state')
      return (
        state.photos
          .find((photo) => photo.id === state.selected)
          .edit.pointColors.find((point) => point.id === id).hue === 1
      )
    },
    first
  )
  const edited = active(await run(page, 'state')).edit
  assert.equal(edited.pointColors[0].hue, 1)
  assert.equal(edited.pointColors[1].hue, 45)
  assert.equal(edited.pointColors[1].saturation, 20)
  await run(page, 'point-select', { id: second })
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  await expectSelection(page, first)
  assert.deepEqual(active(await run(page, 'state')).edit, edited, 'Only committed edits persist')
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
    )
  )
  assert.deepEqual(bytes, Array.from(original))
})

test('Point color selection reconciles removals, history, reset, recipe replacement and photo boundaries', async (t) => {
  const page = await workspace(t)
  const firstPhoto = (await run(page, 'state')).selected
  const first = (await run(page, 'point-add', { color: '#ff0000' })).id
  const second = (await run(page, 'point-add', { color: '#0000ff' })).id
  await run(page, 'point-remove', { id: second })
  await expectSelection(page, first)
  await run(page, 'undo')
  await expectSelection(page, first)
  await run(page, 'point-select', { id: second })
  await run(page, 'point-remove', { id: first })
  await expectSelection(page, second)
  await run(page, 'undo')
  await expectSelection(page, second)
  await run(page, 'copy-edits')
  await page
    .locator('#files')
    .setInputFiles({ name: 'point-other.png', mimeType: 'image/png', buffer: original })
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)
  const secondPhoto = (await run(page, 'state')).selected
  assert.notEqual(secondPhoto, firstPhoto)
  await expectSelection(page, '')
  await run(page, 'paste-edits')
  await expectSelection(page, first)
  await run(page, 'point-select', { id: second })
  await run(page, 'select', { id: firstPhoto })
  await expectSelection(page, first, 'Identical copied point IDs do not carry selection across photos')
  const before = active(await run(page, 'state')).edit
  await assert.rejects(
    () => run(page, 'point-select', { id: second, photoId: secondPhoto }),
    /changed|selected/i
  )
  await assert.rejects(() => run(page, 'point-select', { id: 'missing-point' }), /sample|point|found/i)
  await expectSelection(page, first)
  assert.deepEqual(active(await run(page, 'state')).edit, before)
  await run(page, 'reset')
  await expectSelection(page, '')
  assert.equal(await page.getByLabel('Point hue', { exact: true }).isDisabled(), true)
  await run(page, 'undo')
  await expectSelection(page, first)
  await run(page, 'select-many', { ids: [] })
  assert.equal((await run(page, 'state')).selectedPoint, '')
  await assert.rejects(() => run(page, 'point-select', { id: first }), /select|photo/i)
})

test('Point color pointer sampling adds and selects a new sample after straightening or an existing point selection', async (t) => {
  const page = await workspace(t)
  const first = (await run(page, 'point-add', { color: '#ff0000' })).id
  await run(page, 'point-add', { color: '#0000ff' })
  for (const [index, priorTool] of ['off', 'straighten', 'first-reference'].entries()) {
    await run(page, 'point-select', { id: first })
    if (priorTool !== 'off') {
      await run(page, 'straighten-tool', { axis: 'horizontal' })
      if (priorTool === 'first-reference') {
        const source = await page.locator('#stage canvas').boundingBox()
        await page.mouse.click(source.x + source.width * 0.25, source.y + source.height * 0.25)
        assert.equal(
          await page
            .getByText('First point set. Click the other end of the reference line.', { exact: true })
            .count(),
          1
        )
      }
    }
    const beforeSample = active(await run(page, 'state')).edit
    await page.getByRole('button', { name: 'Sample color', exact: true }).click()
    assert.equal((await run(page, 'state')).sampling, 'point')
    const bounds = await page.locator('#stage canvas').boundingBox()
    assert.ok(bounds?.width)
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await waitForAsyncFunction(
      page,
      async (count) => {
        const state = await window.openlr.run('state')
        return state.photos.find((photo) => photo.id === state.selected).edit.pointColors.length === count
      },
      3 + index,
      { timeout: 3000 }
    )
    const state = await run(page, 'state')
    const points = active(state).edit.pointColors
    assert.equal(points[0].color, '#ff0000')
    assert.equal(points.at(-1).color, '#406080')
    assert.equal(state.sampling, false)
    assert.deepEqual({ ...active(state).edit, pointColors: beforeSample.pointColors }, beforeSample)
    await expectSelection(page, points.at(-1).id)
  }
})
