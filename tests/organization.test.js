import test from 'node:test'
import assert from 'node:assert/strict'
import { serveWorkspace } from './browser-server.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

test('multi-selection, albums, named versions, pasted edits, filtering and reload share the GUI command state', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const directory = await mkdtemp(join(tmpdir(), 'openlr-organize-'))
  const context = await chromium.launchPersistentContext(directory, {
    channel: process.env.CHROME_CHANNEL || 'chrome',
    headless: true
  })
  t.after(async () => {
    await context.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 4 })
  })
  const page = context.pages()[0]
  await page.goto(server.url)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.openlr.run(command, args), { command, args })
  await page.waitForFunction(() => window.openlr)
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 48
    canvas.height = 32
    const paint = canvas.getContext('2d')
    paint.fillStyle = '#697b91'
    paint.fillRect(0, 0, 48, 32)
    return canvas.toDataURL().split(',')[1]
  })
  await page.locator('#files').setInputFiles(
    ['b.png', 'c.png', 'a.png'].map((name) => ({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64')
    }))
  )
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 3)
  await page.locator('#order').selectOption('name')
  await page.waitForFunction(() => document.querySelector('#gallery .tile')?.title === 'a.png')
  await page.getByLabel('Sort direction', { exact: true }).selectOption('desc')
  await page.waitForFunction(() => document.querySelector('#gallery .tile')?.title === 'c.png')
  await page.locator('#gallery .tile').nth(0).click()
  await page
    .locator('#gallery .tile')
    .nth(2)
    .click({ modifiers: ['Control'] })
  assert.equal((await invoke('state')).selection.length, 2)
  await page
    .locator('#gallery .tile')
    .nth(0)
    .click({ modifiers: ['Shift'] })
  assert.equal((await invoke('state')).selection.length, 3)
  await page.locator('#rate').selectOption('4')
  await page.locator('#flag').selectOption('pick')
  let state = await invoke('state')
  assert.ok(state.photos.every((photo) => photo.rating === 4 && photo.flag === 'pick'))
  const album = await invoke('album', { name: 'Trip' })
  await invoke('membership', { album: album.id })
  await invoke('scope', { id: album.id })
  await page.locator('#rename-album').click()
  await page.locator('#organize-dialog input').fill('Favorites')
  await page.locator('#organize-dialog button[value=ok]').click()
  await page.waitForFunction(() => document.getElementById('heading').textContent === 'Favorites')
  assert.equal((await invoke('state')).albums[0].name, 'Favorites')
  state = await invoke('state')
  const source = state.photos.find((photo) => photo.name === 'c.png')
  const targets = state.photos.filter((photo) => photo.id !== source.id).map((photo) => photo.id)
  await invoke('select', { id: source.id })
  await invoke('view', { mode: 'detail' })
  await invoke('edit', { key: 'Exposure', value: 1 })
  await page.locator('#versions summary').click()
  await page.locator('#save-version').click()
  await page.locator('#organize-dialog input').fill('Soft')
  await page.locator('#organize-dialog button[value=ok]').click()
  await page.getByLabel('Restore version Soft', { exact: true }).waitFor()
  await invoke('edit', { key: 'Exposure', value: 2 })
  await page.getByLabel('Restore version Soft', { exact: true }).click()
  state = await invoke('state')
  assert.equal(state.photos.find((photo) => photo.id === source.id).edit.Exposure, 1)
  await page.locator('#copy-edits').click()
  await invoke('select-many', { ids: targets })
  await page.locator('#paste-edits').click()
  state = await invoke('state')
  assert.ok(state.photos.every((photo) => photo.edit.Exposure === 1))
  await invoke('undo')
  assert.equal(
    (await invoke('state')).photos.find((photo) => photo.id === targets[0]).edit.Exposure,
    undefined
  )
  await invoke('redo')
  await invoke('select-many', { ids: [] })
  assert.equal(await page.locator('#copy-edits').isVisible(), false)
  assert.equal((await invoke('state')).selected, '')
  await invoke('select', { id: source.id })
  const temporary = await invoke('version-save', { name: 'Temporary' })
  await invoke('version-rename', { id: temporary.id, name: 'Review' })
  assert.ok(
    (await invoke('state')).photos
      .find((photo) => photo.id === source.id)
      .versions.some((version) => version.name === 'Review')
  )
  await invoke('version-delete', { id: temporary.id })
  assert.equal((await invoke('state')).photos.find((photo) => photo.id === source.id).edit.Exposure, 1)
  await invoke('rate', { value: 1 })
  await page.locator('#catalog-filters summary').click()
  await page.locator('#catalog-filters').getByLabel('Minimum rating', { exact: true }).selectOption('4')
  state = await invoke('state')
  assert.equal(state.photos.length, 2)
  assert.ok(state.selection.every((id) => state.photos.some((photo) => photo.id === id)))
  await page.locator('#catalog-filters').getByLabel('Minimum rating', { exact: true }).selectOption('0')
  await page.getByLabel('Filter edits', { exact: true }).selectOption('yes')
  assert.equal((await invoke('state')).photos.length, 3)
  await invoke('select', { id: source.id })
  await invoke('flag', { value: 'reject' })
  await page.getByLabel('Filter flags', { exact: true }).selectOption('pick')
  assert.equal((await invoke('state')).photos.length, 2)
  await page.getByLabel('Filter flags', { exact: true }).selectOption('any')
  await page.locator('#delete-album').click()
  await page.locator('#organize-dialog button[value=ok]').click()
  await page.waitForFunction(() => document.querySelectorAll('#albums button').length === 0)
  state = await invoke('state')
  assert.equal(state.albums.length, 0)
  assert.equal(state.photos.length, 3)
  assert.ok(state.photos.every((photo) => photo.albums.length === 0))
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  state = await invoke('state')
  assert.equal(state.photos.length, 3)
  assert.equal(state.albums.length, 0)
  const persisted = state.photos.find((photo) => photo.id === source.id)
  assert.equal(persisted.versions[0].name, 'Soft')
  assert.equal(persisted.versions[0].edit.Exposure, 1)
  await invoke('select', { id: source.id })
  await invoke('edit', { key: 'Exposure', value: 3 })
  assert.equal(
    (await invoke('state')).photos.find((photo) => photo.id === source.id).versions[0].edit.Exposure,
    1
  )
  const original = await page.evaluate(async () => {
    const result = await window.openlr.run('export', { format: 'original' })
    return Array.from(new Uint8Array(await result.blob.arrayBuffer()))
  })
  assert.deepEqual(Buffer.from(original), Buffer.from(png, 'base64'))
  const failure = await page.evaluate(() => window.openlr.dispatch('select-many', { ids: ['missing-photo'] }))
  assert.equal(failure.ok, false)
  assert.deepEqual(errors, [])
  if (process.env.OPENLR_ORGANIZATION_SCREENSHOT) {
    await invoke('view', { mode: 'detail' })
    await page.locator('#versions summary').click()
    await page.screenshot({ path: process.env.OPENLR_ORGANIZATION_SCREENSHOT })
  }
})
