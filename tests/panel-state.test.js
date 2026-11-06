import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'

const sidebarPanels = ['Share & review album', 'Migrate photo catalogs']
const catalogPanels = ['Photo', 'Filters']
const inspectorPanels = [
  'Histogram',
  'Presets',
  'Light',
  'Color',
  'Curve',
  'Point curve',
  'Color grading',
  'Color mixer',
  'Effects',
  'Detail',
  'Point color',
  'Optics & geometry',
  'Crop & rotate',
  'Masks & local repair',
  'Info',
  'Versions'
]
const defaults = Object.fromEntries(
  ['photos', ...sidebarPanels, ...catalogPanels, ...inspectorPanels].map((name) => [
    name,
    ['photos', 'Light', 'Color'].includes(name)
  ])
)

test('workspace panels share command state with trusted mouse and keyboard activation', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)

  const run = (command, args = {}) =>
    page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args])
  const nav = page.locator('main > nav')
  const panelElements = () =>
    page
      .locator('main details')
      .evaluateAll((details) =>
        details.map((element) => [element.querySelector(':scope > summary').textContent.trim(), element.open])
      )
  const assertPanels = async (expected, fullState) => {
    assert.deepEqual((fullState ?? (await run('state'))).panels, expected)
    assert.deepEqual((await run('state', { summary: true })).panels, expected)
  }

  const initial = await run('state')
  assert.equal(initial.mode, 'grid')
  await assertPanels(defaults, initial)
  const inventory = await panelElements()
  assert.equal(inventory.length, 20)
  assert.deepEqual(Object.fromEntries(inventory), Object.fromEntries(Object.entries(defaults).slice(1)))
  assert.equal(await nav.isVisible(), true)
  assert.equal(await page.locator('main > aside').isVisible(), false)

  const width = 64
  const height = 48
  const inputs = [80, 120].map((color) => ({
    name: `panels-${color}.png`,
    mimeType: 'image/png',
    buffer: Buffer.from(
      makePng({ width, height, bits: 8, srgb: 0, data: new Uint8Array(width * height * 3).fill(color) })
    )
  }))
  await page.locator('#files').setInputFiles(inputs)
  await page.locator('#gallery .tile').nth(1).waitFor()
  const imported = await run('state')
  const photo = imported.photos.find(({ name }) => name === inputs[0].name)
  const ids = imported.photos.map(({ id }) => id)
  const editedPhoto = (state) => state.photos.find(({ id }) => id === photo.id)
  await run('select', { id: photo.id })
  const recipe = editedPhoto(await run('edit', { key: 'Exposure', value: 0.5 })).edit
  await run('view', { mode: 'grid' })

  // A read queued after an input waits for its dispatcher action. These
  // listeners independently observe the browser input and the watch signal.
  await page.evaluate(() => {
    window.panelEvents = 0
    window.summaryClicks = []
    window.addEventListener('openlr-change', () => window.panelEvents++)
    document.addEventListener(
      'click',
      (event) => {
        const summary = event.target.closest('summary')
        if (summary?.parentElement.matches('main details'))
          window.summaryClicks.push({ title: summary.textContent.trim(), trusted: event.isTrusted })
      },
      true
    )
  })
  const eventCount = () => page.evaluate(() => window.panelEvents)
  const grid = await run('state')
  const beforeInvalid = await eventCount()
  await assert.rejects(run('panel', { name: 'missing-panel', open: true }), /Unknown panel/i)
  const afterInvalid = await run('state')
  await assertPanels(grid.panels, afterInvalid)
  assert.equal(afterInvalid.mode, grid.mode)
  assert.equal(afterInvalid.inspector, grid.inspector)
  assert.deepEqual(afterInvalid.photos, grid.photos)
  assert.deepEqual(afterInvalid.selection, grid.selection)
  assert.equal(await eventCount(), beforeInvalid)

  const expected = { ...defaults }
  for (const name of Object.keys(expected)) {
    const workspace = inspectorPanels.includes(name) ? 'detail' : 'grid'
    const states = [
      [true, true],
      [true, true],
      [false, false],
      [false, false],
      [undefined, true],
      [undefined, false]
    ]
    if (defaults[name]) states.push([true, true])
    for (const [open, result] of states) {
      expected[name] = result
      const state = await run('panel', open === undefined ? { name } : { name, open })
      assert.equal(state.mode, workspace, name)
      await assertPanels(expected, state)
      if (name === 'photos') assert.equal(await nav.isVisible(), result)
      else assert.equal(Object.fromEntries(await panelElements())[name], result, name)
    }
  }
  assert.equal(await page.locator('main > aside').isVisible(), true)

  // Grid and parent visibility hide a surface while preserving its disclosures.
  const shareName = sidebarPanels[0]
  const share = nav.getByRole('button', { name: 'Publish current album', exact: true })
  await run('view', { mode: 'detail', inspector: false })
  await assertPanels(defaults)
  assert.equal(await page.locator('main > aside').isVisible(), false)
  await assertPanels(defaults, await run('panel', { name: 'Light', open: true }))
  assert.equal(await page.locator('main > aside').isVisible(), true)
  await run('view', { mode: 'grid' })
  assert.equal(await page.locator('main > aside').isVisible(), false)
  assert.equal((await run('state')).panels.Light, true)
  await run('panel', { name: shareName, open: true })
  assert.equal(await share.isVisible(), true)
  await run('panel', { name: 'photos', open: false })
  await assertPanels({ ...defaults, photos: false, [shareName]: true })
  assert.equal(await share.isVisible(), false)
  await run('panel', { name: 'photos', open: true })
  assert.equal(await share.isVisible(), true)
  await run('panel', { name: shareName, open: false })

  const beforePair = await eventCount()
  const queued = await page.evaluate(() =>
    Promise.all([
      window.openlr.run('panel', { name: 'Photo' }),
      window.openlr.run('panel', { name: 'Photo' })
    ])
  )
  assert.deepEqual(
    queued.map(({ panels }) => panels.Photo),
    [true, false]
  )
  await assertPanels(defaults)
  assert.equal(await eventCount(), beforePair + 2)

  await run('select-many', { ids })
  await run('rate', { value: 4 })
  await run('select', { id: photo.id })
  const filter = page.locator('#catalog-filters')
  const filterLabel = filter.locator('summary')
  const rating = filter.getByLabel('Minimum rating', { exact: true })
  await run('panel', { name: 'Filters', open: true })
  assert.equal(await rating.isVisible(), true)
  await rating.selectOption('3')
  const filtered = await run('state')
  assert.equal(await filterLabel.textContent(), 'Filters (1)')
  assert.equal(filtered.filters.rating, 3)
  for (const open of [false, true]) {
    const state = await run('panel', { name: 'Filters', open })
    await assertPanels({ ...defaults, Filters: open }, state)
    assert.equal(state.mode, 'grid')
    assert.deepEqual(state.filters, filtered.filters)
    assert.equal(await rating.isVisible(), open)
  }
  assert.equal(await rating.inputValue(), '3')
  const beforeFilterClick = await eventCount()
  await filterLabel.click()
  await assertPanels(defaults)
  assert.equal(await rating.isVisible(), false)
  assert.equal(await eventCount(), beforeFilterClick + 1)

  await run('panel', { name: 'Photo', open: true })
  const autoStack = page.locator('#photo-menu').getByRole('button', { name: 'Stack by capture time…' })
  assert.equal(await autoStack.isVisible(), true)
  const beforeMenu = await eventCount()
  await autoStack.click()
  const stackDialog = page.locator('#stack-dialog')
  await stackDialog.waitFor({ state: 'visible' })
  await assertPanels(defaults)
  assert.equal(await autoStack.isVisible(), false)
  assert.equal(await eventCount(), beforeMenu + 1)
  await stackDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await stackDialog.waitFor({ state: 'hidden' })

  const activateSummary = async (summary, title, input, open) => {
    // Reaching an offscreen control also scrolls its panel. Observe the
    // disclosure after that distinct workspace change has settled.
    await summary.scrollIntoViewIfNeeded()
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    const before = await eventCount()
    const notice = await page.locator('#notice').textContent()
    await page.evaluate(() => (window.summaryClicks.length = 0))
    if (input === 'click') await summary.click()
    else await summary.press(input)
    const state = await run('state')
    assert.equal(state.panels[title], open, input)
    assert.equal(await summary.evaluate((element) => element.parentElement.open), open, input)
    assert.deepEqual(await page.evaluate(() => window.summaryClicks), [{ title, trusted: true }])
    assert.equal(await eventCount(), before + 1, input)
    assert.equal(await page.locator('#notice').textContent(), notice, input)
    await assertPanels(state.panels, state)
    return state
  }

  await run('preferences', { shortcuts: true })
  assert.equal((await run('zoom')).zoom, true)
  const stagePixels = await page.locator('#stage canvas').evaluate((canvas) => {
    window.panelTestCanvas = canvas
    return canvas.toDataURL()
  })
  const histogram = page.locator('#histogram-panel > summary')
  const clipping = page.locator('#clip-indicator')
  assert.equal((await activateSummary(histogram, 'Histogram', 'click', true)).zoom, true)
  assert.equal(await clipping.isVisible(), true)
  await assertPanels({ ...defaults, Histogram: true }, await run('panel', { name: 'Histogram', open: true }))
  assert.equal((await activateSummary(histogram, 'Histogram', 'Space', false)).zoom, true)
  assert.equal(await clipping.isVisible(), false)
  assert.deepEqual(
    await page.locator('#stage canvas').evaluate((canvas) => ({
      sameCanvas: canvas === window.panelTestCanvas,
      pixels: canvas.toDataURL()
    })),
    { sameCanvas: true, pixels: stagePixels }
  )

  const crop = await run('crop-tool')
  assert.equal(crop.panels['Crop & rotate'], true)
  assert.equal(await page.locator('#crop-tool').isVisible(), true)
  const draft = await run('crop-drag', { grip: 'new', x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.8 })
  const versions = page.locator('#versions > summary')
  const duringCrop = await activateSummary(versions, 'Versions', 'Enter', true)
  assert.equal(await page.locator('#save-version').isVisible(), true)
  assert.equal(duringCrop.cropping, true)
  assert.deepEqual(duringCrop.cropDraft, draft.cropDraft)
  assert.deepEqual(editedPhoto(duringCrop).edit, recipe)
  await run('crop-cancel')

  const masks = 'Masks & local repair'
  const localTool = page.getByLabel('Local tool', { exact: true })
  assert.equal((await run('local-tool', { tool: 'brush' })).panels[masks], true)
  assert.equal(await localTool.isVisible(), true)
  assert.equal((await run('local-tool', { tool: 'off' })).panels[masks], false)
  assert.equal(await localTool.isVisible(), false)

  await page.keyboard.press('p')
  assert.equal((await run('state')).panels.photos, false)
  assert.equal(await nav.isVisible(), false)
  await page.keyboard.press('p')
  assert.equal((await run('state')).panels.photos, true)
  assert.equal(await nav.isVisible(), true)
  await page.keyboard.press('Shift+P')
  assert.equal((await run('state')).panels.Presets, true)
  assert.equal(await page.locator('#preset-list').isVisible(), true)

  const final = await run('state')
  assert.deepEqual(final.photos, filtered.photos)
  assert.deepEqual(editedPhoto(await run('undo')).edit, photo.edit)
  assert.deepEqual(editedPhoto(await run('redo')).edit, recipe)
  await run('filter', { rating: 0 })
  assert.deepEqual(
    (await run('library-undo')).photos.map(({ id, rating }) => ({ id, rating })),
    imported.photos.map(({ id, rating }) => ({ id, rating }))
  )
  const original = await page.evaluate(async () => {
    const { blob } = await window.openlr.run('export', { format: 'original' })
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  assert.deepEqual(Buffer.from(original), inputs[0].buffer)

  await page.reload()
  await page.waitForFunction(() => window.openlr)
  const reopened = await run('state')
  await assertPanels(defaults, reopened)
  assert.deepEqual(editedPhoto(reopened).edit, recipe)
  assert.deepEqual(errors, [])
})
