import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'

const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
const grading = (state) => state.photos.find((photo) => photo.id === state.selected).edit.colorGrading
async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  await page.locator('#files').setInputFiles({
    name: 'grading-input.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      makePng({ width: 24, height: 16, bits: 8, colorType: 2, data: new Uint8Array(24 * 16 * 3).fill(96) })
    )
  })
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 1)
  await run(page, 'view', { mode: 'detail' })
  await run(page, 'panel', { name: 'Color grading', open: true })
  return page
}

for (const [blurFirst, sameField] of [
  [true, false],
  [false, false],
  [true, true]
])
  test(`${sameField ? 'repeated' : 'adjacent'} grading numbers survive a pending save with second blur ${blurFirst ? 'before' : 'after'} completion`, async (t) => {
    const page = await workspace(t)
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')
      Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
        ...descriptor,
        set(handler) {
          if (this.mode !== 'readwrite' || !this.objectStoreNames.contains('photos'))
            return descriptor.set.call(this, handler)
          Object.defineProperty(IDBTransaction.prototype, 'oncomplete', descriptor)
          // Complete the real write, holding only its notification to the app.
          return descriptor.set.call(this, (event) => {
            window.releaseGradingWrite = () => handler.call(this, event)
          })
        }
      })
    })
    const balance = page.locator('#grading-balance-number'),
      blending = page.locator(sameField ? '#grading-balance-number' : '#grading-blending-number')
    await balance.fill('-25')
    await balance.press('Tab')
    await page.waitForFunction(() => Boolean(window.releaseGradingWrite))
    await blending.fill('80')
    if (blurFirst) await blending.press('Tab')
    await page.evaluate(() => window.releaseGradingWrite())
    const interim = await run(page, 'state')
    if (!blurFirst) {
      assert.equal(grading(interim).balance, -25)
      assert.equal(await blending.inputValue(), '80')
      await blending.press('Tab')
    }
    assert.equal(grading(await run(page, 'state')).balance, sameField ? 80 : -25)
    assert.equal(grading(await run(page, 'state')).blending, sameField ? 50 : 80)
    assert.equal(await page.locator('#notice').textContent(), '')
    await run(page, 'undo')
    assert.equal(grading(await run(page, 'state')).balance, -25)
    assert.equal(grading(await run(page, 'state')).blending, 50)
    await run(page, 'redo')
    await page.reload()
    await run(page, 'view', { mode: 'detail' })
    assert.equal(grading(await run(page, 'state')).balance, sameField ? 80 : -25)
    assert.equal(grading(await run(page, 'state')).blending, sameField ? 50 : 80)
  })

test('numeric drafts preserve unrelated updates and refuse a conflicting field update', async (t) => {
  const page = await workspace(t)
  const blending = page.locator('#grading-blending-number')
  await blending.fill('80')
  await run(page, 'grading-set', { value: { balance: -25 } })
  assert.equal(await blending.inputValue(), '80')
  await blending.press('Tab')
  assert.equal(grading(await run(page, 'state')).balance, -25)
  assert.equal(grading(await run(page, 'state')).blending, 80)
  await blending.fill('90')
  await run(page, 'grading-set', { value: { balance: -25, blending: 60 } })
  await blending.press('Tab')
  assert.equal(grading(await run(page, 'state')).blending, 60)
  assert.match(await page.locator('#notice').textContent(), /edits changed/)
  await run(page, 'undo')
  assert.equal(grading(await run(page, 'state')).blending, 80)
})

test('grading field patches share queue validation, history and photo guards', async (t) => {
  const page = await workspace(t)
  const { selected: photoId } = await run(page, 'state')
  const patch = (field, value, expectedValue) => ({ photoId, patch: { field, value, expectedValue } })
  await run(page, 'grading-set', patch('balance', -25, 0))
  await run(page, 'grading-set', patch('blending', 80, 50))
  await run(page, 'grading-set', patch('global.hue', 360, 0))
  const expected = grading(await run(page, 'state'))
  assert.equal(expected.balance, -25)
  assert.equal(expected.blending, 80)
  assert.equal(expected.global.hue, 0)
  for (const args of [
    patch('balance', 10, 0),
    { ...patch('balance', 10, -25), photoId: 'stale-photo' },
    { patch: { field: 'balance', value: 10, expectedValue: -25 } },
    patch('global.unknown', 10, 0),
    patch('blending', 101, 80),
    { ...patch('balance', 10, -25), value: {} }
  ]) {
    await assert.rejects(() => run(page, 'grading-set', args))
    assert.deepEqual(grading(await run(page, 'state')), expected)
  }
  await run(page, 'undo')
  assert.equal(grading(await run(page, 'state')).balance, -25)
  assert.equal(grading(await run(page, 'state')).blending, 50)
})

test('Escape and changing grading view discard an uncommitted numeric draft', async (t) => {
  const page = await workspace(t)
  const blending = page.locator('#grading-blending-number')
  await blending.fill('80')
  await blending.press('Escape')
  assert.equal(await blending.inputValue(), '50')
  await blending.press('Tab')
  assert.equal(grading(await run(page, 'state')), undefined)
  await blending.fill('90')
  await run(page, 'grading-mode', { mode: 'global' })
  assert.equal(await blending.inputValue(), '50')
  await blending.press('Tab')
  assert.equal(grading(await run(page, 'state')), undefined)
})
