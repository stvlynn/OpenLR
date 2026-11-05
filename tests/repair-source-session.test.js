import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { parse } from '../cli/openlr.mjs'

test('repair source GUI and CLI share guarded source state, cancellation and the actual clone recipe', async (t) => {
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
    canvas.width = canvas.height = 100
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 50, 100)
    ctx.fillStyle = '#0000ff'
    ctx.fillRect(50, 0, 50, 100)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve))
    await window.openlr.run('import', {
      files: [
        new File([blob], 'one.png', { type: 'image/png' }),
        new File([blob], 'two.png', { type: 'image/png' })
      ]
    })
  })
  await run('local-tool', { tool: 'clone' })
  const before = await run('state'),
    id = before.selected
  const photo = (state) => state.photos.find((item) => item.id === id)
  const source = { x: 0.25, y: 0.5 }
  await page.evaluate(() => {
    window.repairChanges = 0
    window.addEventListener('openlr-change', () => window.repairChanges++)
  })
  assert.deepEqual(await run('repair-source', { point: source, photoId: id }), {
    point: source,
    picking: false
  })
  assert.deepEqual((await run('state', { summary: true })).repairSource, { point: source, picking: false })
  assert.deepEqual(photo(await run('state')).edit, photo(before).edit)
  assert.equal(await page.evaluate(() => window.repairChanges), 1)
  await run('repair-source')
  assert.equal(await page.evaluate(() => window.repairChanges), 1)
  for (const args of [{ point: source, picking: true }, { point: { x: 2, y: 0.5 } }]) {
    assert.throws(() => parse(['repair-source', '--args', JSON.stringify(args), '--dry-run']))
    const invalid = await page.evaluate((args) => window.openlr.dispatch('repair-source', args), args)
    assert.equal(invalid.ok, false)
    assert.deepEqual(await run('repair-source'), { point: source, picking: false })
  }
  const bad = await page.evaluate(() =>
    window.openlr.dispatch('repair-source', { picking: true, photoId: 'stale' })
  )
  assert.equal(bad.ok, false)
  assert.deepEqual(await run('repair-source'), { point: source, picking: false })
  await page.getByRole('button', { name: 'Choose repair source', exact: true }).click()
  assert.equal((await run('state')).repairSource.picking, true)
  await page.getByLabel('Local tool', { exact: true }).focus()
  await page.keyboard.press('Escape')
  assert.deepEqual(await run('repair-source'), { point: source, picking: false })
  assert.equal((await run('state')).mode, 'detail')
  await run('repair-source', { picking: true })
  await page.getByRole('button', { name: 'Cancel source selection', exact: true }).click()
  assert.deepEqual(await run('repair-source'), { point: source, picking: false })
  const box = await page.locator('#stage canvas').boundingBox()
  await page.keyboard.down('Alt')
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5)
  await page.keyboard.up('Alt')
  const chosen = await run('repair-source')
  assert.ok(Math.abs(chosen.point.x - 0.2) < 0.01)
  assert.deepEqual(photo(await run('state')).edit, photo(before).edit)
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.77, box.y + box.height * 0.5)
  await run('repair-source', { point: chosen.point })
  await page.mouse.up()
  assert.deepEqual(photo(await run('state')).edit, photo(before).edit)
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.77, box.y + box.height * 0.5, { steps: 3 })
  await page.mouse.up()
  const after = await run('state')
  assert.deepEqual(photo(after).edit.localTools.repairs[0].source, chosen.point)
  const pixel = await page.evaluate(async () => {
    const { blob } = await window.openlr.run('preview')
    const bitmap = await createImageBitmap(blob),
      canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    return [...ctx.getImageData(75, 50, 1, 1).data]
  })
  assert.ok(pixel[0] > 240 && pixel[2] < 15, JSON.stringify(pixel))
  await run('undo')
  assert.deepEqual(photo(await run('state')).edit, photo(before).edit)
  await run('repair-source', { picking: true })
  await run('view', { mode: 'grid' })
  assert.deepEqual(await run('repair-source'), { point: chosen.point, picking: false })
  await run('select', { id: before.photos.find((item) => item.id !== id).id })
  assert.deepEqual(await run('repair-source'), { point: null, picking: false })
})
