import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'

const original = Buffer.from(
  makePng({
    width: 60,
    height: 40,
    bits: 8,
    colorType: 2,
    srgb: 0,
    data: new Uint8Array(60 * 40 * 3).fill(96)
  })
)
const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
const photo = (state, id) => state.photos.find((photo) => photo.id === id)
async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page.locator('#files').setInputFiles(
    ['source.png', 'target.png', 'other.png'].map((name) => ({
      name,
      mimeType: 'image/png',
      buffer: original
    }))
  )
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 3)
  const ids = Object.fromEntries(
    (await run(page, 'state')).photos.map((photo) => [photo.name.split('.')[0], photo.id])
  )
  await run(page, 'select', { id: ids.source })
  return { page, ids }
}
async function closeChooser(page, action = 'confirm') {
  await page.evaluate(() => {
    window.copyDialogClosed = new Promise((resolve) =>
      document.querySelector('#copy-edits-dialog').addEventListener('close', resolve, { once: true })
    )
  })
  if (action === 'Escape') await page.keyboard.press('Escape')
  else await page.locator('#copy-edits-' + action).click()
  await page.evaluate(async () => {
    await window.copyDialogClosed
  })
  await run(page, 'state')
}
async function chooseLight(page) {
  await page.locator('#choose-edits').click()
  await page.locator('#copy-edits-none').click()
  assert.equal(await page.locator('#copy-edits-confirm').isDisabled(), true)
  await page.locator('#copy-edits-dialog input[name=copy-group][value=light]').check()
  assert.equal(await page.locator('#copy-edits-confirm').isEnabled(), true)
}

test('GUI selected Light edits copy an independent snapshot, reset absent values and preserve target crop/version through batch undo', async (t) => {
  const { page, ids } = await workspace(t)
  const targetCrop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }
  await run(page, 'processing', { version: 1 })
  await run(page, 'edit', { key: 'Exposure', value: 1.25 })
  await run(page, 'edit', { key: 'crop', value: { x: 0, y: 0, w: 0.5, h: 1 } })
  for (const id of [ids.target, ids.other]) {
    await run(page, 'select', { id })
    await run(page, 'processing', { version: 2 })
    await run(page, 'edit', { key: 'Exposure', value: -1 })
    await run(page, 'edit', { key: 'Contrast', value: 17 })
    await run(page, 'edit', { key: 'crop', value: targetCrop })
    await run(page, 'edit', { key: 'Noise reduction', value: 30 })
  }
  const before = await run(page, 'state')
  await run(page, 'select', { id: ids.source })
  await chooseLight(page)
  await closeChooser(page)
  await page.locator('#choose-edits').click()
  assert.deepEqual(
    await page
      .locator('#copy-edits-dialog input[name=copy-group]:checked')
      .evaluateAll((inputs) => inputs.map((input) => input.value)),
    ['light'],
    'Choices persist for this session'
  )
  await closeChooser(page, 'cancel')
  const clipboard = (await run(page, 'state')).clipboard
  assert.equal(clipboard.source, ids.source)
  assert.ok(clipboard.keys.includes('Exposure') && clipboard.keys.includes('Contrast'))
  assert.ok(!clipboard.keys.includes('crop') && !clipboard.keys.includes('processVersion'))
  await run(page, 'edit', { key: 'Exposure', value: 2 })
  await run(page, 'select-many', { ids: [ids.target, ids.other] })
  await page.locator('#paste-edits').click()
  const after = await run(page, 'state')
  for (const id of [ids.target, ids.other]) {
    const edit = photo(after, id).edit
    assert.equal(edit.Exposure, 1.25, 'Clipboard retains the recipe captured at copy confirmation')
    assert.equal(edit.Contrast, undefined, 'Selecting an absent source adjustment resets its target value')
    assert.deepEqual(edit.crop, targetCrop)
    assert.equal(edit.processVersion, 2)
    assert.equal(edit['Noise reduction'], 30)
  }
  await run(page, 'select', { id: ids.target })
  await run(page, 'undo')
  assert.deepEqual(photo(await run(page, 'state'), ids.target).edit, photo(before, ids.target).edit)
  assert.equal(photo(await run(page, 'state'), ids.other).edit.Exposure, 1.25)
  await run(page, 'select', { id: ids.other })
  await run(page, 'undo')
  assert.deepEqual(photo(await run(page, 'state'), ids.other).edit, photo(before, ids.other).edit)
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
    )
  )
  assert.deepEqual(bytes, Array.from(original))
})

test('copy chooser cancellation and stale-source refusal preserve clipboard while ordinary Copy edits still replaces the complete recipe', async (t) => {
  const { page, ids } = await workspace(t)
  await run(page, 'edit', { key: 'Exposure', value: 0.5 })
  await page.locator('#copy-edits').click()
  const baseline = (await run(page, 'state')).clipboard
  assert.equal(baseline.keys, null)
  for (const action of ['cancel', 'Escape']) {
    await chooseLight(page)
    await closeChooser(page, action)
    assert.deepEqual((await run(page, 'state')).clipboard, baseline)
  }
  await chooseLight(page)
  await run(page, 'select', { id: ids.target })
  await closeChooser(page)
  assert.deepEqual((await run(page, 'state')).clipboard, baseline)
  assert.match(await page.locator('#notice').textContent(), /changed|selected/i)
  await assert.rejects(
    () => run(page, 'copy-edits', { keys: ['Exposure'], photoId: ids.source }),
    /changed|selected/i
  )
  assert.deepEqual((await run(page, 'state')).clipboard, baseline)
  await run(page, 'processing', { version: 2 })
  await run(page, 'edit', { key: 'crop', value: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } })
  await run(page, 'select', { id: ids.source })
  await chooseLight(page)
  await run(page, 'edit', { key: 'Exposure', value: 1.5 })
  await closeChooser(page)
  await run(page, 'select', { id: ids.target })
  await run(page, 'paste-edits')
  assert.equal(
    photo(await run(page, 'state'), ids.target).edit.Exposure,
    1.5,
    'Same-source edits made before confirmation are included'
  )
  await run(page, 'select', { id: ids.source })
  await page.locator('#copy-edits').click()
  assert.equal((await run(page, 'state')).clipboard.keys, null)
  const sourceEdit = photo(await run(page, 'state'), ids.source).edit
  await run(page, 'select', { id: ids.target })
  await page.locator('#paste-edits').click()
  assert.deepEqual(photo(await run(page, 'state'), ids.target).edit, sourceEdit)
})
