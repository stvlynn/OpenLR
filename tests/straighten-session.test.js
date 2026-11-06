import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { holdCatalogThumbnail } from './catalog-thumbnail-hold.mjs'

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  const run = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.openlr.run(command, args), { command, args })
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 240
    canvas.height = 160
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#6a8c99'
    ctx.fillRect(0, 0, 240, 160)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve))
    await window.openlr.run('import', { files: [new File([blob], 'reference.png', { type: 'image/png' })] })
    window.straightenChanges = 0
    window.addEventListener('openlr-change', () => window.straightenChanges++)
  })
  await run('view', { mode: 'detail' })
  const before = await run('state')
  const id = before.selected
  const click = async (x, y) => {
    const box = await page.locator('#stage canvas').boundingBox()
    await page.mouse.click(box.x + box.width * x, box.y + box.height * y)
  }
  return { page, run, before, id, click }
}

test('straighten reference exposes live points and cancels through GUI and guarded shared commands', async (t) => {
  const { page, run, before, id, click } = await workspace(t)
  await run('straighten-tool', { axis: 'horizontal' })
  const changes = await page.evaluate(() => window.straightenChanges)
  await click(0.25, 0.35)
  let state = await run('state')
  assert.equal(state.straightenTool.axis, 'horizontal')
  assert.ok(Math.abs(state.straightenTool.first.x - 0.25) < 0.01)
  assert.ok(Math.abs(state.straightenTool.first.y - 0.35) < 0.01)
  assert.deepEqual((await run('state', { summary: true })).straightenTool, state.straightenTool)
  assert.ok((await page.evaluate(() => window.straightenChanges)) > changes)
  const failed = await page.evaluate(() =>
    window.openlr.dispatch('straighten-tool', { axis: 'off', photoId: 'stale' })
  )
  assert.equal(failed.ok, false)
  assert.deepEqual((await run('state')).straightenTool, state.straightenTool)
  await page.locator('#optics-panel').evaluate((node) => {
    node.open = true
  })
  await page.getByLabel('Lens focal length', { exact: true }).focus()
  await page.keyboard.press('Escape')
  state = await run('state')
  assert.deepEqual(state.straightenTool, { axis: 'off', first: null })
  assert.equal(state.mode, 'detail')
  assert.deepEqual(state.photos[0].edit, before.photos[0].edit)
  await run('straighten-tool', { axis: 'vertical', photoId: id })
  await click(0.3, 0.4)
  await run('straighten-tool', { axis: 'off', photoId: id })
  assert.deepEqual((await run('state')).straightenTool, { axis: 'off', first: null })
  await page.getByRole('button', { name: 'Draw straighten line', exact: true }).click()
  await click(0.3, 0.4)
  await page.getByRole('button', { name: 'Cancel straighten line', exact: true }).click()
  assert.deepEqual((await run('state')).straightenTool, { axis: 'off', first: null })
  await run('straighten-tool')
  await click(0.2, 0.3)
  await run('view', { mode: 'grid' })
  assert.deepEqual((await run('state')).straightenTool, { axis: 'off', first: null })
  await run('straighten-tool')
  await click(0.25, 0.3)
  const { first, referenceId } = (await run('state')).straightenTool
  assert.ok(referenceId)
  const end = { x: 0.75, y: 0.5 }
  state = await run('straighten-point', { point: end, referenceId, photoId: id })
  assert.deepEqual(state.straightenTool, { axis: 'off', first: null })
  const angle = (-Math.atan2((end.y - first.y) * 160, (end.x - first.x) * 240) * 180) / Math.PI
  assert.ok(Math.abs(state.photos[0].edit.optics.rotate - angle) < 0.001)
  await run('undo')
  assert.deepEqual((await run('state')).photos[0].edit, before.photos[0].edit)
})

test('straighten-point stages normalized original coordinates and rejects stale photo, edit and reference guards', async (t) => {
  const { page, run, id } = await workspace(t)
  await run('edit', { key: 'crop', value: { x: 0.15, y: 0.1, w: 0.75, h: 0.8 } })
  await run('rotate', { direction: 'right' })
  const saved = (await run('state')).photos[0].edit
  const start = { x: 0.32, y: 0.25 },
    end = { x: 0.54, y: 0.72 }
  await run('straighten-tool', { axis: 'horizontal', photoId: id })
  await assert.rejects(run('straighten-point', { point: start, photoId: 'stale' }), /selected photo changed/)
  await assert.rejects(run('straighten-point', { point: { x: 1.1, y: 0.5 } }), /between 0 and 1/)
  assert.deepEqual((await run('state')).straightenTool, { axis: 'horizontal', first: null })
  const changes = await page.evaluate(() => window.straightenChanges)
  const initial = await run('straighten-point', { point: start, photoId: id })
  const first = initial.straightenTool
  assert.deepEqual(first.first, start)
  assert.ok(first.referenceId)
  assert.equal(await page.evaluate(() => window.straightenChanges), changes + 1)
  assert.deepEqual(initial.photos[0].edit, saved)
  assert.deepEqual((await run('state', { summary: true })).straightenTool, first)
  await run('rate', { value: 2, advance: false })
  assert.deepEqual((await run('state')).straightenTool, first, 'metadata retains the current geometry owner')

  await run('straighten-tool', { axis: 'off', referenceId: first.referenceId, photoId: id })
  await run('straighten-tool', { axis: 'horizontal', photoId: id })
  const next = (await run('straighten-point', { point: start })).straightenTool
  assert.notEqual(next.referenceId, first.referenceId)
  await assert.rejects(
    run('straighten-tool', { axis: 'off', referenceId: first.referenceId }),
    /reference changed/
  )
  await assert.rejects(
    run('straighten-point', { point: end, referenceId: first.referenceId }),
    /reference changed/
  )
  await assert.rejects(
    run('straighten-point', { point: start, referenceId: next.referenceId }),
    /distinct points/
  )
  assert.deepEqual((await run('state')).straightenTool, next)
  await run('flip')
  assert.deepEqual((await run('state')).straightenTool, { axis: 'off', first: null })
  await assert.rejects(
    run('straighten-point', { point: end, referenceId: next.referenceId }),
    /reference changed/
  )
  await run('undo')
  assert.deepEqual((await run('state')).photos[0].edit, saved)

  await run('straighten-tool', { axis: 'horizontal' })
  const { referenceId } = (await run('straighten-point', { point: start })).straightenTool
  const applied = await run('straighten-point', { point: end, referenceId, photoId: id })
  // After a quarter turn, a horizontal display reference is vertical in the
  // uncropped original. Its angle uses the full 240 × 160 source dimensions.
  const originalAngle = (Math.atan2((end.y - start.y) * 160, (end.x - start.x) * 240) * 180) / Math.PI
  assert.ok(Math.abs(applied.photos[0].edit.optics.rotate - (90 - originalAngle)) < 0.001)
  assert.deepEqual(applied.straightenTool, { axis: 'off', first: null })
  await run('undo')
  assert.deepEqual((await run('state')).photos[0].edit, saved)
})

test('a successful explicit straighten completes the active reference and rejects a queued GUI second point', async (t) => {
  const { page, run, before, id, click } = await workspace(t)
  await run('straighten-tool', { axis: 'horizontal', photoId: id })
  await click(0.25, 0.3)
  const picking = (await run('state')).straightenTool
  const args = { start: picking.first, end: { x: 0.75, y: 0.5 }, axis: 'horizontal', photoId: id }
  await assert.rejects(run('straighten', { ...args, photoId: 'stale' }), /selected photo changed/)
  await assert.rejects(run('straighten', { ...args, end: args.start }), /distinct points/)
  assert.deepEqual((await run('state')).straightenTool, picking)

  await holdCatalogThumbnail(page)
  await page.evaluate((args) => {
    const race = (window.straightenRace = { canvas: document.querySelector('#stage canvas') })
    race.done = window.openlr.run('straighten', args)
  }, args)
  await page.waitForFunction(() => Boolean(window.catalogThumbnailHold.release))
  assert.ok(
    await page.evaluate(() => window.straightenRace.canvas === document.querySelector('#stage canvas'))
  )
  await click(0.68, 0.7)
  const completed = await page.evaluate(async () => {
    window.catalogThumbnailHold.release()
    return window.straightenRace.done
  })
  const rotation = (-Math.atan2(0.2 * 160, 0.5 * 240) * 180) / Math.PI
  assert.ok(Math.abs(completed.photos[0].edit.optics.rotate - rotation) < 0.01)
  assert.deepEqual(completed.straightenTool, { axis: 'off', first: null })
  assert.deepEqual((await run('state')).photos[0].edit, completed.photos[0].edit)
  await page
    .locator('#notice', { hasText: 'The straighten reference changed; choose two new points' })
    .waitFor()
  await click(0.68, 0.7)
  assert.deepEqual((await run('state')).photos[0].edit, completed.photos[0].edit)
  await run('undo')
  assert.deepEqual((await run('state')).photos[0].edit, before.photos[0].edit)
})
