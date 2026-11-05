import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'

const pixels = new Uint8Array(60 * 40 * 3)
for (let i = 0; i < pixels.length; i += 3) pixels.set([64, 96, 128], i)
const original = Buffer.from(makePng({ width: 60, height: 40, bits: 8, colorType: 2, srgb: 0, data: pixels }))
const identity = [
  { x: 0, y: 0 },
  { x: 1, y: 1 }
]
const redCurve = [
  { x: 0, y: 0.1 },
  { x: 1, y: 0.9 }
]
const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
const active = (state) => state.photos.find((p) => p.id === state.selected)
const stageSample = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('#stage canvas')
    return Array.from(
      canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)
        .data
    )
  })
async function waitStage(page, previous, equal) {
  await waitForAsyncFunction(
    page,
    ({ previous, equal }) => {
      const canvas = document.querySelector('#stage canvas')
      if (!canvas) return false
      const pixel = Array.from(
        canvas
          .getContext('2d')
          .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
      )
      return (JSON.stringify(pixel) === JSON.stringify(previous)) === equal
    },
    { previous, equal }
  )
}

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
    .setInputFiles({ name: 'curve-source.png', mimeType: 'image/png', buffer: original })
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 1)
  await run(page, 'view', { mode: 'detail' })
  await page.locator('#tone-curves > summary').click()
  return page
}
async function graphPoint(page, x, y) {
  await page.locator('#curve-graph').scrollIntoViewIfNeeded()
  const box = await page.locator('#curve-graph').boundingBox()
  return { x: box.x + ((12 + 216 * x) / 240) * box.width, y: box.y + ((228 - 216 * y) / 240) * box.height }
}
async function sample(page) {
  return page.evaluate(async () => {
    const { blob } = await window.openlr.run('export', { format: 'image/png' })
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    return Array.from(context.getImageData(10, 10, 1, 1).data)
  })
}

test('point-curve GUI adds, drags and deletes knots through shared state, with keyboard cancellation and per-edit history', async (t) => {
  const page = await workspace(t)
  const point = await graphPoint(page, 0.5, 0.7)
  await page.mouse.click(point.x, point.y)
  await waitForAsyncFunction(page, async () => {
    const state = await window.openlr.run('state')
    return state.photos.find((p) => p.id === state.selected).edit.toneCurves?.rgb?.length === 3
  })
  let state = await run(page, 'state')
  assert.equal(state.toneCurve.index, 1)
  assert.ok(Math.abs(active(state).edit.toneCurves.rgb[1].y - 0.7) < 0.01)
  const inserted = active(state).edit
  const insertedPixels = await stageSample(page)
  const circle = await page.locator('#curve-graph circle[data-index="1"]').boundingBox()
  const moved = await graphPoint(page, 0.6, 0.8)
  await page.mouse.move(circle.x + circle.width / 2, circle.y + circle.height / 2)
  await page.mouse.down()
  await page.mouse.move(moved.x, moved.y, { steps: 4 })
  await waitStage(page, insertedPixels, false)
  assert.deepEqual(
    active(await run(page, 'state')).edit,
    inserted,
    'Live drag preview does not commit the recipe'
  )
  await page.mouse.up()
  await waitForAsyncFunction(page, async () => {
    const state = await window.openlr.run('state')
    return state.photos.find((p) => p.id === state.selected).edit.toneCurves?.rgb?.[1].x > 0.59
  })
  const dragged = active(await run(page, 'state')).edit
  await run(page, 'undo')
  assert.deepEqual(active(await run(page, 'state')).edit, inserted, 'A drag commits one history entry')
  await run(page, 'redo')
  assert.deepEqual(active(await run(page, 'state')).edit, dragged)
  await page.locator('#curve-graph').focus()
  await page.keyboard.press('ArrowDown')
  await waitForAsyncFunction(
    page,
    async (oldY) => {
      const state = await window.openlr.run('state')
      return state.photos.find((p) => p.id === state.selected).edit.toneCurves.rgb[1].y < oldY
    },
    dragged.toneCurves.rgb[1].y
  )
  const beforeCancel = active(await run(page, 'state')).edit
  const beforeCancelPixels = await stageSample(page)
  const currentCircle = await page.locator('#curve-graph circle[data-index="1"]').boundingBox()
  await page.mouse.move(currentCircle.x + currentCircle.width / 2, currentCircle.y + currentCircle.height / 2)
  await page.mouse.down()
  await page.mouse.move(point.x, point.y)
  await waitStage(page, beforeCancelPixels, false)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await waitStage(page, beforeCancelPixels, true)
  assert.deepEqual(active(await run(page, 'state')).edit, beforeCancel)
  await page.locator('#curve-delete').click()
  await waitForAsyncFunction(page, async () => {
    const state = await window.openlr.run('state')
    return !state.photos.find((p) => p.id === state.selected).edit.toneCurves
  })
  await run(page, 'curve-select', { index: 0 })
  assert.equal(await page.locator('#curve-input').isDisabled(), true)
  assert.equal(await page.locator('#curve-delete').isDisabled(), true)
  await page.locator('#curve-add').click()
  await waitForAsyncFunction(page, async () => {
    const state = await window.openlr.run('state')
    return state.photos.find((p) => p.id === state.selected).edit.toneCurves?.rgb?.length === 3
  })
  await run(page, 'filter', { edited: 'no' })
  assert.equal((await run(page, 'state')).photos.length, 1, 'An identity knot does not mark the photo edited')
  await run(page, 'filter', { edited: 'any' })
  await run(page, 'curve-set', { channel: 'rgb', points: identity })
  await page.locator('#curve-channel').selectOption('blue')
  await waitForAsyncFunction(
    page,
    async () => (await window.openlr.run('state')).toneCurve.channel === 'blue'
  )
  assert.equal((await run(page, 'state', { summary: true })).toneCurve.channel, 'blue')
  await page.locator('#curve-output').fill('0.1')
  await page.locator('#curve-output').press('Tab')
  await waitForAsyncFunction(page, async () => {
    const state = await window.openlr.run('state')
    return state.photos.find((p) => p.id === state.selected).edit.toneCurves?.blue?.[0].y === 0.1
  })
  await page.locator('#curve-reset').click()
  await waitForAsyncFunction(page, async () => {
    const state = await window.openlr.run('state')
    return !state.photos.find((p) => p.id === state.selected).edit.toneCurves
  })
})

test('channel curves affect exported pixels in both processes and survive presets, versions, XMP, selective copy and reload', async (t) => {
  const page = await workspace(t)
  const source = (await run(page, 'state')).selected
  for (const version of [1, 2]) {
    await run(page, 'processing', { version })
    await run(page, 'curve-set', { channel: 'red', points: redCurve, photoId: source })
    const rgba = await sample(page)
    assert.ok(Math.abs(rgba[0] - 77) <= 1, `Process ${version} red ${rgba[0]}`)
    assert.deepEqual(rgba.slice(1), [96, 128, 255])
    await run(page, 'curve-set', { channel: 'red', points: identity })
    assert.deepEqual(await sample(page), [64, 96, 128, 255])
  }
  await run(page, 'curve-set', { channel: 'red', points: redCurve })
  const saved = active(await run(page, 'state')).edit
  const preset = await run(page, 'preset-save', { name: 'Channel proof' })
  const version = await run(page, 'version-save', { name: 'Channel version' })
  const xml = await page.evaluate(async () => {
    const state = await window.openlr.run('state')
    return (await import('./xmp.js')).exportXmp(state.photos.find((p) => p.id === state.selected))
  })
  await run(page, 'reset')
  await run(page, 'preset-apply', { id: preset.id })
  assert.deepEqual(active(await run(page, 'state')).edit.toneCurves, saved.toneCurves)
  await run(page, 'reset')
  await run(page, 'version-restore', { id: version.id })
  assert.deepEqual(active(await run(page, 'state')).edit, saved)
  await run(page, 'reset')
  await run(page, 'apply-xmp', { xml })
  assert.deepEqual(active(await run(page, 'state')).edit, saved)
  await run(page, 'copy-edits', { keys: ['toneCurves'] })
  await page
    .locator('#files')
    .setInputFiles({ name: 'curve-target.png', mimeType: 'image/png', buffer: original })
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)
  const target = (await run(page, 'state')).selected
  await run(page, 'edit', { key: 'Exposure', value: 0.5 })
  await run(page, 'paste-edits')
  assert.deepEqual(active(await run(page, 'state')).edit, { Exposure: 0.5, toneCurves: saved.toneCurves })
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  await run(page, 'select', { id: target })
  assert.deepEqual(active(await run(page, 'state')).edit.toneCurves, saved.toneCurves)
  await run(page, 'select', { id: source })
  await run(page, 'curve-set', { channel: 'red', points: identity })
  await run(page, 'copy-edits', { keys: ['toneCurves'] })
  await run(page, 'select', { id: target })
  await run(page, 'paste-edits')
  assert.deepEqual(active(await run(page, 'state')).edit, { Exposure: 0.5 })
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
    )
  )
  assert.deepEqual(bytes, Array.from(original))
})

test('curve commands reject stale source, stale channel and invalid knots without replacing persisted edits', async (t) => {
  const page = await workspace(t)
  const id = (await run(page, 'state')).selected
  await run(page, 'curve-set', { channel: 'red', points: redCurve })
  const before = active(await run(page, 'state')).edit
  for (const args of [
    { channel: 'red', points: identity, photoId: 'other-photo' },
    { channel: 'red', points: identity, expectedPoints: identity },
    {
      channel: 'red',
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 0.5 },
        { x: 1, y: 1 }
      ]
    },
    {
      channel: 'red',
      points: [
        { x: 0.1, y: 0 },
        { x: 1, y: 1 }
      ]
    }
  ])
    await assert.rejects(() => run(page, 'curve-set', args))
  assert.deepEqual(active(await run(page, 'state')).edit, before)
  await run(page, 'curve-set', { channel: 'red', points: identity, expectedPoints: redCurve, photoId: id })
  await run(page, 'undo')
  assert.deepEqual(active(await run(page, 'state')).edit, before, 'Rejected edits add no history entry')
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  assert.deepEqual(active(await run(page, 'state')).edit, before)
  await run(page, 'view', { mode: 'detail' })
  await page.locator('#tone-curves > summary').click()
  await run(page, 'curve-channel', { channel: 'red' })
  const start = await graphPoint(page, 0, 0.1)
  const end = await graphPoint(page, 0, 0.3)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y)
  const newer = [
    { x: 0, y: 0.2 },
    { x: 1, y: 0.8 }
  ]
  await run(page, 'curve-set', { channel: 'red', points: newer })
  await page.mouse.up()
  assert.deepEqual(
    active(await run(page, 'state')).edit.toneCurves.red,
    newer,
    'A stale pointer draft cannot replace a newer channel edit'
  )
  await run(page, 'undo')
  assert.deepEqual(active(await run(page, 'state')).edit, before)
  await page
    .locator('#files')
    .setInputFiles({ name: 'curve-new-source.png', mimeType: 'image/png', buffer: original })
  await waitForAsyncFunction(page, async (id) => (await window.openlr.run('state')).selected !== id, id)
  const other = (await run(page, 'state')).selected
  await run(page, 'select', { id })
  await run(page, 'view', { mode: 'detail' })
  await waitStage(page, [77, 96, 128, 255], true)
  const sourcePixels = await stageSample(page)
  const dragStart = await graphPoint(page, 0, 0.1)
  const dragEnd = await graphPoint(page, 0, 0.3)
  await page.mouse.move(dragStart.x, dragStart.y)
  await page.mouse.down()
  await page.mouse.move(dragEnd.x, dragEnd.y)
  await waitStage(page, sourcePixels, false)
  await run(page, 'select', { id: other })
  await page.mouse.up()
  await waitStage(page, [64, 96, 128, 255], true)
  const changed = await run(page, 'state')
  assert.equal(active(changed).edit.toneCurves, undefined)
  assert.deepEqual(
    changed.photos.find((p) => p.id === id).edit,
    before,
    'Changing the photo cancels the draft without applying it to either photo'
  )
})
