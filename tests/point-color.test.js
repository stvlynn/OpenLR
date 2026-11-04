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
