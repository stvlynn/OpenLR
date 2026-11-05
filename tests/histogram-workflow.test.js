import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'

function expectedBins(pixels) {
  const channels = ['red', 'green', 'blue', 'luma']
  const bins = Object.fromEntries(channels.map((channel) => [channel, Array(256).fill(0)]))
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue
    const [red, green, blue] = pixels.slice(offset, offset + 3)
    bins.red[red]++
    bins.green[green]++
    bins.blue[blue]++
    bins.luma[Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue)]++
  }
  return bins
}

test('Histogram plots the published preview while the default command measures the committed edit', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  await page.goto(server.url)
  const width = 96,
    height = 64,
    pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let rgba
      if (x < 64) rgba = [96, 96, 96, 255]
      else if (x < 74) rgba = [255, 255, 255, 255]
      else if (x < 84) rgba = [0, 0, 0, 255]
      else if (x < 92) rgba = [20, 90, 200, 255]
      else rgba = [200, 150, 100, 0]
      pixels.set(rgba, (y * width + x) * 4)
    }
  const source = makePng({ width, height, bits: 8, colorType: 6, data: pixels })
  await page.locator('#files').setInputFiles({
    name: 'histogram-bands.png',
    mimeType: 'image/png',
    buffer: Buffer.from(source)
  })
  await page.locator('#gallery .tile').waitFor()
  const run = (command, args = {}) =>
      page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args]),
    displayed = () => run('histogram', { source: 'display' }),
    committed = () => run('histogram'),
    panel = page.locator('#histogram-panel > summary')
  const panelClick = async () => {
    await panel.evaluate((summary) => {
      window.nextHistogramToggle = new Promise((resolve) =>
        summary.parentElement.addEventListener('toggle', () => resolve(), { once: true })
      )
    })
    await panel.click()
    await page.evaluate(() => window.nextHistogramToggle)
  }
  const plot = () =>
    page.locator('#histogram').evaluate((canvas) => {
      const { width, height } = canvas,
        { data } = canvas.getContext('2d').getImageData(0, 0, width, height)
      const columns = Array(width).fill(0)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) columns[x] += data[(y * width + x) * 4 + 3]
      return columns.indexOf(Math.max(...columns))
    })
  const assertPeak = async (expected) => {
    // The antialiased stroke can distribute the tip across adjacent columns.
    const actual = await plot()
    assert.ok(Math.abs(actual - expected) <= 1, `Expected plot peak near ${expected}, got ${actual}`)
  }

  const original = expectedBins(pixels)
  await run('view', { mode: 'detail' })
  assert.deepEqual(await committed(), original)
  assert.deepEqual(await displayed(), original)
  await run('edit', { key: 'Exposure', value: 1 })
  const editedPixels = await page.evaluate(async () => {
    const { blob } = await window.openlr.run('export', { format: 'image/png' }),
      image = await createImageBitmap(blob),
      canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    image.close()
    return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data)
  })
  const edited = expectedBins(editedPixels)
  assert.equal(edited.luma[133], 64 * height)
  assert.deepEqual(await committed(), edited)
  assert.deepEqual(await run('histogram', { source: 'edited' }), edited)

  await run('compare-pair')
  assert.equal(await page.locator('#stage > canvas').count(), 2)
  await panelClick()
  await assertPeak(133)
  assert.deepEqual(await displayed(), edited)
  await run('zoom')
  await assertPeak(133)
  assert.deepEqual(await displayed(), edited)

  await run('compare')
  assert.equal(await page.locator('#stage > canvas').count(), 1)
  await assertPeak(96)
  assert.deepEqual(await displayed(), original)
  assert.deepEqual(await committed(), edited)
  await run('compare')
  assert.deepEqual(await displayed(), edited)
  await assertPeak(133)

  await panelClick()
  await run('clipping')
  const clipped = await page.locator('#stage > canvas').evaluate((canvas) => {
    const context = canvas.getContext('2d')
    return [68, 78].map((x) => Array.from(context.getImageData(x, 32, 1, 1).data))
  })
  assert.deepEqual(clipped, [
    [255, 0, 0, 255],
    [0, 48, 255, 255]
  ])
  await panelClick()
  await assertPeak(133)
  assert.deepEqual(await displayed(), edited)
  const owned = await page.evaluate(async () => {
    const run = window.openlr.run,
      bins = await run('histogram', { source: 'display' })
    bins.red.fill(-1)
    bins.luma.length = 0
    return run('histogram', { source: 'display' })
  })
  assert.deepEqual(owned, edited)
  await assertPeak(133)

  await run('clipping')
  // Send only the input event so the real slider paints a draft without committing it.
  await page.getByRole('slider', { name: 'Exposure', exact: true }).evaluate((slider) => {
    slider.value = '0'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await waitForAsyncFunction(
    page,
    async (count) => (await window.openlr.run('histogram', { source: 'display' })).luma[96] === count,
    original.luma[96]
  )
  assert.deepEqual(await displayed(), original)
  await assertPeak(96)
  assert.deepEqual(await committed(), edited)
  assert.equal((await run('state')).photos[0].edit.Exposure, 1)

  await run('view', { mode: 'grid' })
  await assert.rejects(displayed(), /photo preview in Detail/)
  assert.deepEqual(await committed(), edited)
})
