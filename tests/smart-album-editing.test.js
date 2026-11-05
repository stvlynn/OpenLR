import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'
import { validateSmartRule } from '../web/smart-album-rule.js'

const all = { text: '', rating: 0, flag: 'any', edited: 'any' }
const png = Buffer.from(
  makePng({
    width: 16,
    height: 12,
    bits: 8,
    colorType: 2,
    srgb: 0,
    data: new Uint8Array(16 * 12 * 3).fill(100)
  })
)
const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page
    .locator('#files')
    .setInputFiles(
      ['sunrise.png', 'river.png', 'other.png'].map((name) => ({ name, mimeType: 'image/png', buffer: png }))
    )
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 3)
  return page
}
const albumRule = async (page, id) => (await run(page, 'state')).albums.find((a) => a.id === id).rule

test('smart rules require an explicit complete valid replacement without mutating input', () => {
  const rule = { text: '河流', rating: 3, flag: 'pick', edited: 'no' }
  const normalized = validateSmartRule(rule)
  assert.deepEqual(normalized, rule)
  assert.notEqual(normalized, rule)
  for (const value of [
    null,
    [],
    {},
    { ...rule, text: 5 },
    { ...rule, rating: 2.5 },
    { ...rule, rating: 6 },
    { ...rule, flag: 'unknown' },
    { ...rule, edited: 'unknown' },
    { ...rule, extra: true }
  ])
    assert.throws(() => validateSmartRule(value))
  assert.deepEqual(rule, { text: '河流', rating: 3, flag: 'pick', edited: 'no' })
})

test('GUI smart-rule edits cancel cleanly, preserve view filters, persist and retain original bytes', async (t) => {
  const page = await workspace(t),
    rows = (await run(page, 'photos')).photos
  const first = rows.find((p) => p.name === 'sunrise.png').id,
    second = rows.find((p) => p.name === 'river.png').id
  await run(page, 'select', { id: first })
  await run(page, 'rate', { value: 4 })
  await run(page, 'flag', { value: 'pick' })
  await run(page, 'edit', { key: 'Exposure', value: 0.5 })
  await run(page, 'select', { id: second })
  await run(page, 'rate', { value: 3 })
  await run(page, 'search', { text: 'sunrise' })
  await run(page, 'filter', { rating: 3, flag: 'pick', edited: 'yes' })
  const album = await run(page, 'album', { name: 'Working set', smart: true })
  const originalRule = { ...album.rule }
  await run(page, 'search', { text: '' })
  await run(page, 'filter', { rating: 0, flag: 'any', edited: 'any' })
  await run(page, 'scope', { id: album.id })
  assert.deepEqual(
    (await run(page, 'photos')).photos.map((p) => p.id),
    [first]
  )
  await page.locator('#edit-album-rules').click()
  const dialog = page.locator('#smart-album-dialog')
  assert.equal(await dialog.getByLabel('Search', { exact: true }).inputValue(), 'sunrise')
  assert.equal(await dialog.getByLabel('Minimum rating', { exact: true }).inputValue(), '3')
  await page.screenshot({ path: '.workspace/smart-rule-dialog.png' })
  await dialog.getByLabel('Search', { exact: true }).fill('discard this')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.deepEqual(await albumRule(page, album.id), originalRule)
  await run(page, 'search', { text: 'river' })
  await run(page, 'filter', { rating: 2, flag: 'any', edited: 'any' })
  await page.locator('#edit-album-rules').click()
  assert.equal(await dialog.getByLabel('Search', { exact: true }).inputValue(), 'sunrise')
  await dialog.getByLabel('Search', { exact: true }).fill('')
  await dialog.getByLabel('Minimum rating', { exact: true }).selectOption('0')
  await dialog.getByLabel('Flag', { exact: true }).selectOption('any')
  await dialog.getByLabel('Edit status', { exact: true }).selectOption('any')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await waitForAsyncFunction(
    page,
    async () =>
      (await window.openlr.run('state')).albums.find((a) => a.name === 'Working set').rule.text === ''
  )
  const state = await run(page, 'state')
  assert.equal(state.search, 'river')
  assert.deepEqual(state.filters, { rating: 2, flag: 'any', edited: 'any' })
  assert.equal(state.scope, album.id)
  assert.equal(state.albums.find((a) => a.id === album.id).name, 'Working set')
  assert.deepEqual(
    state.photos.map((p) => p.id),
    [second]
  )
  assert.ok(state.selection.every((id) => state.photos.some((p) => p.id === id)))
  await run(page, 'search', { text: '' })
  await run(page, 'filter', { rating: 0, flag: 'any', edited: 'any' })
  assert.equal((await run(page, 'photos')).total, 3)
  await run(page, 'album-rule', { id: album.id, rule: { ...all, edited: 'yes' } })
  assert.equal((await run(page, 'photos')).total, 1)
  await run(page, 'scope', { id: 'all' })
  await run(page, 'select', { id: second })
  await run(page, 'edit', { key: 'Exposure', value: 0.25 })
  await run(page, 'scope', { id: album.id })
  assert.equal((await run(page, 'photos')).total, 2)
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  assert.deepEqual(await albumRule(page, album.id), { ...all, edited: 'yes' })
  await run(page, 'scope', { id: album.id })
  assert.equal((await run(page, 'photos')).total, 2)
  await run(page, 'scope', { id: 'all' })
  const originals = await page.evaluate(async () => {
    const files = []
    for (const photo of (await window.openlr.run('photos')).photos) {
      await window.openlr.run('select', { id: photo.id })
      files.push(
        Array.from(
          new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
        )
      )
    }
    return files
  })
  originals.forEach((bytes) => assert.deepEqual(bytes, Array.from(png)))
})

test('rule validation, write failure and no-op preserve storage/history; shared undo restores rules', async (t) => {
  const page = await workspace(t)
  const album = await run(page, 'album', { name: 'Rules', smart: true })
  const manual = await run(page, 'album', { name: 'Manual' })
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  for (const args of [
    { id: manual.id, rule: all },
    { id: 'missing', rule: all },
    { id: album.id, rule: { edited: 'yes' } },
    { id: album.id, rule: { ...all, rating: -1 } },
    { id: album.id, rule: { ...all, text: [] } }
  ])
    await assert.rejects(() => run(page, 'album-rule', args))
  const failed = await page.evaluate(async (id) => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'albums') throw new DOMException('Simulated full storage', 'QuotaExceededError')
      return put.apply(this, args)
    }
    try {
      await window.openlr.run('album-rule', {
        id,
        rule: { text: 'river', rating: 0, flag: 'any', edited: 'any' }
      })
      return null
    } catch (error) {
      return error.message
    } finally {
      IDBObjectStore.prototype.put = put
    }
  }, album.id)
  assert.match(failed, /Simulated full storage/)
  assert.deepEqual(await albumRule(page, album.id), all)
  const storedRule = await page.evaluate(async (id) => {
    const db = await import('./catalog.js')
    return (await db.all('albums')).find((album) => album.id === id).rule
  }, album.id)
  assert.deepEqual(storedRule, all)
  await run(page, 'library-undo')
  assert.deepEqual(await albumRule(page, album.id), all)
  const desired = { ...all, text: 'river' }
  await run(page, 'album-rule', { id: album.id, rule: desired })
  await run(page, 'album-rule', { id: album.id, rule: desired })
  await run(page, 'history-undo')
  assert.deepEqual(await albumRule(page, album.id), all)
  await run(page, 'history-redo')
  assert.deepEqual(await albumRule(page, album.id), desired)
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  assert.deepEqual(await albumRule(page, album.id), desired)
  await run(page, 'scope', { id: manual.id })
  assert.equal(await page.locator('#edit-album-rules').isVisible(), false)
})
