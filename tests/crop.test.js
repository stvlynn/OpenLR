import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('draw, resize, move, cancel and commit a crop using the workspace handles', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  await page.goto(server.url)
  await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 400
    c.height = 300
    c.getContext('2d').fillRect(0, 0, c.width, c.height)
    const blob = await new Promise((cb) => c.toBlob(cb))
    await window.openlr.run('import', { files: [new File([blob], 'crop.png', { type: 'image/png' })] })
  })
  await page.keyboard.press('c')
  const surface = page.locator('.crop-surface')
  await surface.waitFor()
  const canvas = await page.locator('#stage canvas').boundingBox()
  const drag = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    await page.mouse.move(x2, y2, { steps: 4 })
    await page.mouse.up()
  }
  await page.evaluate(() => {
    window.dragRevisions = 0
    window.addEventListener('openlr-change', () => window.dragRevisions++)
  })
  await drag(canvas.x + 40, canvas.y + 30, canvas.x + 240, canvas.y + 210)
  assert.equal(await page.evaluate(() => window.dragRevisions), 1)
  const drawn = await page.evaluate(async () => (await window.openlr.run('state')).cropDraft)
  const agentDrawn = await page.evaluate(
    ({ width, height }) =>
      window.openlr.run('crop-drag', {
        grip: 'new',
        x1: 40 / width,
        y1: 30 / height,
        x2: 240 / width,
        y2: 210 / height
      }),
    canvas
  )
  for (const key of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(drawn[key] - agentDrawn.cropDraft[key]) < 0.005)
  const grip = await surface.locator('[data-grip=se]').boundingBox()
  await drag(grip.x + 5, grip.y + 5, grip.x + 45, grip.y + 35)
  await drag(canvas.x + 120, canvas.y + 100, canvas.x + 160, canvas.y + 120)
  await page.keyboard.press('Enter')
  await surface.waitFor({ state: 'detached' })
  const recipe = () => page.evaluate(async () => (await window.openlr.run('state')).photos[0].edit)
  const { crop } = await recipe()
  assert.ok(Math.abs(crop.x - 0.2) < 0.015 && Math.abs(crop.y - 1 / 6) < 0.015)
  assert.ok(Math.abs(crop.w - 0.6) < 0.015 && Math.abs(crop.h - 0.7) < 0.015)
  await page.keyboard.press('c')
  await surface.waitFor()
  const draft = () =>
    page.evaluate(async () => (await window.openlr.run('state', { summary: true })).cropDraft)
  const initial = await draft()
  const invalid = await page.evaluate(async () => {
    const { run } = window.openlr
    const failures = []
    for (const [command, args] of [
      ['crop-nudge', { dx: NaN, dy: 0 }],
      ['crop-drag', { grip: 'new', x1: -1, y1: 0, x2: 1, y2: 1 }]
    ]) {
      try {
        await run(command, args)
        failures.push(false)
      } catch {
        failures.push(true)
      }
    }
    return { failures, draft: (await run('state')).cropDraft }
  })
  assert.deepEqual(invalid.failures, [true, true])
  assert.deepEqual(invalid.draft, initial)
  await page.keyboard.press('ArrowRight')
  const nudged = await draft()
  assert.ok(nudged.x > initial.x)
  assert.equal(nudged.y, initial.y)
  const reversed = await page.evaluate(() => window.openlr.run('crop-nudge', { dx: -1, dy: 0 }))
  assert.ok(Math.abs(reversed.cropDraft.x - initial.x) < 1e-9)
  await page.keyboard.press('Escape')
  await surface.waitFor({ state: 'detached' })
  assert.equal(await draft(), null)
  assert.deepEqual((await recipe()).crop, crop)
})

test('composition guide UI and shared agent command preserve draft, pixels and export', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  await page.goto(server.url)
  await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 400
    c.height = 300
    const g = c.getContext('2d')
    g.fillStyle = '#6a9'
    g.fillRect(0, 0, 400, 300)
    g.fillStyle = '#c38'
    g.fillRect(10, 30, 100, 120)
    const blob = await new Promise((cb) => c.toBlob(cb))
    await window.openlr.run('import', { files: [new File([blob], 'guide.png', { type: 'image/png' })] })
    await window.openlr.run('crop-tool')
    await window.openlr.run('crop-drag', { grip: 'new', x1: 0.15, y1: 0.1, x2: 0.85, y2: 0.9 })
    window.guideExport = async () => {
      const { blob } = await window.openlr.run('export', { format: 'image/png' })
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    }
  })
  const before = await page.evaluate(async () => ({
    state: await window.openlr.run('state'),
    pixels: document.querySelector('#stage canvas').toDataURL(),
    exported: await window.guideExport()
  }))
  const select = page.locator('#crop-guide')
  for (const type of [
    'none',
    'grid',
    'thirds',
    'fifths',
    'diagonal',
    'center',
    'triangle',
    'golden-ratio',
    'golden-spiral',
    'aspect-ratios'
  ]) {
    await select.selectOption(type)
    await page.waitForFunction((type) => document.querySelector('.crop-guide').dataset.type === type, type)
    const state = await page.evaluate(() => window.openlr.run('state', { summary: true }))
    assert.equal(state.cropGuide.type, type)
    assert.deepEqual(state.cropDraft, before.state.cropDraft)
    assert.equal((await page.locator('.crop-guide .light').getAttribute('d')) === '', type === 'none')
  }
  const reply = await page.evaluate(() =>
    window.openlr.dispatch('crop-guide', { type: 'golden-spiral', orientation: 1 })
  )
  assert.equal(reply.ok, true)
  assert.deepEqual(reply.result.cropGuide, { type: 'golden-spiral', orientation: 1 })
  assert.equal(await select.inputValue(), 'golden-spiral')
  assert.equal(await page.locator('#crop-guide-orientation').inputValue(), '1')
  await page.locator('#crop-guide-orientation').selectOption('3')
  await page.waitForFunction(() => document.querySelector('.crop-guide').dataset.orientation === '3')
  assert.deepEqual(await page.evaluate(async () => (await window.openlr.run('state')).cropGuide), {
    type: 'golden-spiral',
    orientation: 3
  })
  const after = await page.evaluate(async () => ({
    state: await window.openlr.run('state'),
    pixels: document.querySelector('#stage canvas').toDataURL(),
    exported: await window.guideExport()
  }))
  assert.deepEqual(after.state.photos[0].edit, before.state.photos[0].edit)
  assert.equal(after.pixels, before.pixels)
  assert.deepEqual(after.exported, before.exported)
  await page.evaluate(() => window.openlr.run('crop-guide', { type: 'thirds' }))
  // Measured in the displayed coordinate system, including responsive resizing.
  const checkCoordinates = async () => {
    const actual = await page.locator('.crop-guide').evaluate((svg) => {
      const frame = svg.parentElement.getBoundingClientRect()
      const canvas = document.querySelector('#stage canvas').getBoundingClientRect()
      const path = svg.querySelector('.light')
      const point = path.getPointAtLength(0).matrixTransform(path.getScreenCTM())
      return {
        frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
        canvas: { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height },
        point: { x: point.x, y: point.y }
      }
    })
    const r = before.state.cropDraft
    assert.ok(Math.abs(actual.frame.x - actual.canvas.x - r.x * actual.canvas.width) < 1)
    assert.ok(Math.abs(actual.frame.y - actual.canvas.y - r.y * actual.canvas.height) < 1)
    assert.ok(Math.abs(actual.point.x - actual.frame.x - actual.frame.width / 3) < 2)
  }
  await checkCoordinates()
  await page.setViewportSize({ width: 1100, height: 780 })
  // A nonzero viewBox can still describe the old viewport. Wait for the
  // ResizeObserver redraw to match the resized canvas before measuring it.
  await page.waitForFunction((r) => {
    const frame = document.querySelector('.crop-surface').getBoundingClientRect(),
      canvas = document.querySelector('#stage canvas').getBoundingClientRect()
    return (
      Math.abs(frame.x - canvas.x - r.x * canvas.width) < 1 &&
      Math.abs(frame.y - canvas.y - r.y * canvas.height) < 1 &&
      Math.abs(frame.width - r.w * canvas.width) < 1 &&
      Math.abs(frame.height - r.h * canvas.height) < 1
    )
  }, before.state.cropDraft)
  await checkCoordinates()
  // The SVG must not intercept moving a draft through one of its visible lines.
  const frame = await page.locator('.crop-surface').boundingBox()
  await page.mouse.move(frame.x + frame.width / 3, frame.y + frame.height / 2)
  await page.mouse.down()
  await page.mouse.move(frame.x + frame.width / 3 + 12, frame.y + frame.height / 2 + 6)
  await page.mouse.up()
  const moved = await page.evaluate(async () => (await window.openlr.run('state')).cropDraft)
  assert.ok(moved.x > before.state.cropDraft.x)
  await page.evaluate(() => window.openlr.run('crop-tool'))
  await page.locator('.crop-guide').waitFor({ state: 'detached' })
  const committed = await page.evaluate(async () => (await window.openlr.run('state')).photos[0].edit)
  assert.deepEqual(committed.crop, moved)
  assert.equal(Object.hasOwn(committed, 'cropGuide'), false)
  await page.evaluate(() => window.openlr.run('crop-tool'))
  assert.equal(await page.locator('.crop-guide').getAttribute('data-type'), 'thirds')
})
