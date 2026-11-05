import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'

const original = Buffer.from(
  makePng({
    width: 40,
    height: 30,
    bits: 8,
    colorType: 2,
    srgb: 0,
    data: new Uint8Array(40 * 30 * 3).fill(96)
  })
)
const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page
    .locator('#files')
    .setInputFiles(
      ['A.png', 'B.png', 'C.png'].map((name) => ({ name, mimeType: 'image/png', buffer: original }))
    )
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 3)
  const ids = Object.fromEntries((await run(page, 'state')).photos.map((photo) => [photo.name[0], photo.id]))
  return { page, ids }
}
async function closeDialog(page, selector, action) {
  await page.evaluate((selector) => {
    window.confirmationClosed = new Promise((resolve) =>
      document.querySelector(selector).addEventListener('close', resolve, { once: true })
    )
  }, selector)
  if (action === 'Escape') await page.keyboard.press('Escape')
  else await page.locator(selector).getByRole('button', { name: action, exact: true }).click()
  await page.evaluate(async () => {
    await window.confirmationClosed
  })
  await run(page, 'state')
}
async function storedIds(page) {
  return page.evaluate(async () =>
    (await (await import('./catalog.js')).all('photos')).map((photo) => photo.id).sort()
  )
}

test('permanent-delete confirmation rejects changed sets, accepts reordered sets and never reuses confirmation after Escape or Cancel', async (t) => {
  const { page, ids } = await workspace(t)
  await run(page, 'select-all')
  await run(page, 'delete')
  await run(page, 'scope', { id: 'trash' })
  await run(page, 'view', { mode: 'detail' })
  const all = Object.values(ids).sort()
  await run(page, 'select', { id: ids.A })
  await page.locator('#purge').click()
  await run(page, 'select', { id: ids.B })
  await closeDialog(page, '#purge-dialog', 'Delete permanently')
  assert.deepEqual(await storedIds(page), all)
  assert.match(await page.locator('#notice').textContent(), /changed|select|confirm/i)
  await run(page, 'select', { id: ids.A })
  await page.locator('#purge').click()
  await run(page, 'select-many', { ids: [ids.A, ids.B] })
  assert.equal((await run(page, 'state')).selected, ids.A)
  await closeDialog(page, '#purge-dialog', 'Delete permanently')
  assert.deepEqual(
    await storedIds(page),
    all,
    'An expanded set with the same active photo is not the confirmed target'
  )
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  assert.deepEqual(await storedIds(page), all)
  await run(page, 'scope', { id: 'trash' })
  await run(page, 'view', { mode: 'detail' })
  await run(page, 'select-many', { ids: [ids.A, ids.B] })
  await page.locator('#purge').click()
  await run(page, 'select-many', { ids: [ids.B, ids.A] })
  await closeDialog(page, '#purge-dialog', 'Delete permanently')
  assert.deepEqual(await storedIds(page), [ids.C])
  await run(page, 'select', { id: ids.C })
  await page.locator('#purge').click()
  await closeDialog(page, '#purge-dialog', 'Escape')
  assert.deepEqual(await storedIds(page), [ids.C])
  await page.locator('#purge').click()
  await closeDialog(page, '#purge-dialog', 'Cancel')
  assert.deepEqual(await storedIds(page), [ids.C])
  await assert.rejects(() => run(page, 'purge', { expectedIds: [ids.A] }), /changed|select|confirm/i)
  assert.deepEqual(await storedIds(page), [ids.C])
})

test('guarded permanent delete preserves shared originals and existing unguarded CLI behavior', async (t) => {
  const { page, ids } = await workspace(t)
  await run(page, 'select', { id: ids.A })
  await assert.rejects(() => run(page, 'purge', { expectedIds: [ids.A] }), /deleted|library/i)
  await run(page, 'virtual-copy')
  const copy = (await run(page, 'state')).photos.find((photo) => photo.originalId === ids.A)
  assert.ok(copy)
  await run(page, 'select', { id: ids.A })
  await run(page, 'delete')
  await run(page, 'scope', { id: 'trash' })
  await run(page, 'select', { id: ids.A })
  await run(page, 'purge', { expectedIds: [ids.A] })
  await run(page, 'scope', { id: 'all' })
  await run(page, 'select', { id: copy.id })
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
    )
  )
  assert.deepEqual(bytes, Array.from(original))
  await run(page, 'delete')
  await run(page, 'scope', { id: 'trash' })
  await run(page, 'select', { id: copy.id })
  await run(page, 'purge')
  assert.equal(
    await page.evaluate(
      async (id) =>
        (await (await import('./catalog.js')).all('originals')).some((original) => original.id === id),
      ids.A
    ),
    false
  )
  await run(page, 'select-many', { ids: [] })
  await assert.rejects(() => run(page, 'purge', { expectedIds: [] }), /select|photo/i)
})

test('album rename and delete confirmations retain the album displayed when opened despite a later scope change', async (t) => {
  const { page } = await workspace(t)
  const albumA = await run(page, 'album', { name: 'Album A' })
  const albumB = await run(page, 'album', { name: 'Album B' })
  const before = await storedIds(page)
  await run(page, 'scope', { id: albumA.id })
  await page.locator('#rename-album').click()
  assert.equal(await page.locator('#organize-dialog input').inputValue(), 'Album A')
  await run(page, 'scope', { id: albumB.id })
  await page.locator('#organize-dialog input').fill('Renamed A')
  await closeDialog(page, '#organize-dialog', 'Save')
  let state = await run(page, 'state')
  assert.equal(state.albums.find((album) => album.id === albumA.id).name, 'Renamed A')
  assert.equal(state.albums.find((album) => album.id === albumB.id).name, 'Album B')
  assert.equal(state.scope, albumB.id)
  await run(page, 'scope', { id: albumA.id })
  await page.locator('#delete-album').click()
  await run(page, 'scope', { id: albumB.id })
  await closeDialog(page, '#organize-dialog', 'Delete')
  state = await run(page, 'state')
  assert.equal(
    state.albums.some((album) => album.id === albumA.id),
    false
  )
  assert.equal(state.albums.find((album) => album.id === albumB.id).name, 'Album B')
  assert.deepEqual(await storedIds(page), before)
  await run(page, 'scope', { id: albumB.id })
  await page.locator('#delete-album').click()
  await closeDialog(page, '#organize-dialog', 'Escape')
  assert.ok((await run(page, 'state')).albums.some((album) => album.id === albumB.id))
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  assert.deepEqual(
    (await run(page, 'state')).albums.map((album) => album.id),
    [albumB.id]
  )
})
