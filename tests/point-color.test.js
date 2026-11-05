import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('point color targets the sampled color, workspace clipping leaves exported pixels alone, and XMP restores the recipe', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 120
    c.height = 80
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#d04020'
    ctx.fillRect(0, 0, 60, 80)
    ctx.fillStyle = '#2040d0'
    ctx.fillRect(60, 0, 60, 80)
    const blob = await new Promise((resolve) => c.toBlob(resolve)),
      run = window.openlr.run
    await run('import', { files: [new File([blob], 'colors.png', { type: 'image/png' })] })
    await run('view', { mode: 'detail' })
    const { color } = await run('sample-color', { x: 0.2, y: 0.5 })
    const { id } = await run('point-add', { color })
    await run('point-update', { id, hue: 90 })
    async function sample() {
      const { blob } = await run('export', { format: 'image/png' })
      const img = await createImageBitmap(blob)
      ctx.drawImage(img, 0, 0)
      img.close()
      return [...ctx.getImageData(20, 20, 1, 1).data, ...ctx.getImageData(100, 20, 1, 1).data]
    }
    const edited = await sample()
    await run('clipping')
    const after = await sample()
    const xml = await (await run('export', { format: 'application/rdf+xml' })).blob.text()
    await run('reset')
    await run('apply-xmp', { xml })
    return { color, edited, after, roundtrip: await sample() }
  })
  assert.equal(result.color, '#d04020')
  assert.ok(result.edited[1] > result.edited[0])
  assert.deepEqual(result.edited.slice(4), [32, 64, 208, 255])
  assert.deepEqual(result.edited, result.after)
  assert.deepEqual(result.edited, result.roundtrip)
})

test('clipping state follows GUI and CLI while display warnings stay out of exported pixels', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 100
    canvas.height = 50
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 50, 50)
    ctx.fillStyle = '#000000'
    ctx.fillRect(50, 0, 50, 50)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve))
    await window.openlr.run('import', { files: [new File([blob], 'clipping.png', { type: 'image/png' })] })
    await window.openlr.run('view', { mode: 'detail' })
  })
  const run = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.openlr.run(command, args), { command, args })
  const before = await run('state')
  assert.equal(before.clipping, false)
  const pixels = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('#stage canvas'),
        ctx = canvas.getContext('2d')
      return [0.25, 0.75].map((x) => [
        ...ctx.getImageData(Math.floor(x * canvas.width), Math.floor(canvas.height / 2), 1, 1).data
      ])
    })
  assert.deepEqual(await pixels(), [
    [255, 255, 255, 255],
    [0, 0, 0, 255]
  ])
  assert.equal((await run('clipping')).clipping, true)
  assert.equal((await run('state', { summary: true })).clipping, true)
  assert.equal(await page.locator('#clip-indicator').getAttribute('aria-pressed'), 'true')
  assert.deepEqual(await pixels(), [
    [255, 0, 0, 255],
    [0, 48, 255, 255]
  ])
  const exported = await page.evaluate(async () => {
    const { blob } = await window.openlr.run('export', { format: 'image/png' })
    const bitmap = await createImageBitmap(blob),
      canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    return [25, 75].map((x) => [...ctx.getImageData(x, 25, 1, 1).data])
  })
  assert.deepEqual(exported, [
    [255, 255, 255, 255],
    [0, 0, 0, 255]
  ])
  await page.locator('#histogram-panel > summary').click()
  await page.locator('#clip-indicator').click()
  assert.equal((await run('state')).clipping, false)
  assert.equal((await run('state', { summary: true })).clipping, false)
  assert.deepEqual(await pixels(), exported)
  await page.keyboard.press('j')
  assert.equal((await run('state')).clipping, true)
  await run('sample-tool')
  assert.equal((await run('state', { summary: true })).clipping, false)
  assert.deepEqual((await run('state')).photos, before.photos)
})
