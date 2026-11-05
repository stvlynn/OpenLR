import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { Organization } from '../web/organization.js'
import { smartMatch } from '../web/stacks.js'

test('saved smart filters use the same neutral-recipe semantics as the current catalog view', () => {
  const organization = new Organization(),
    neutral = [
      {},
      { processVersion: 1 },
      { processVersion: 2 },
      { processVersion: 2, Exposure: 0, flip: false, crop: null }
    ],
    edited = [{ Exposure: 0.5 }, { processVersion: 1, Exposure: 0.5 }, { processVersion: 2, Exposure: 0.5 }]
  for (const status of ['any', 'yes', 'no']) {
    organization.setFilters({ rating: 3, flag: 'pick', edited: status })
    const rule = { ...organization.filters, text: 'camera' }
    for (const [edits, changed] of [
      [neutral, false],
      [edited, true]
    ])
      for (const edit of edits) {
        const photo = { name: 'camera.png', rating: 4, flag: 'pick', edit }
        assert.equal(smartMatch(photo, rule), organization.matches(photo))
        assert.equal(smartMatch(photo, rule), status === 'any' || changed === (status === 'yes'))
        assert.equal(smartMatch({ ...photo, rating: 2 }, rule), false)
        assert.equal(smartMatch({ ...photo, flag: '' }, rule), false)
        assert.equal(smartMatch({ ...photo, name: 'other.png' }, rule), false)
      }
  }
  assert.equal(smartMatch({ name: 'a.png', rating: 0, flag: '', edit: {} }), false)
})

test('GUI saved smart albums preserve edited and unedited membership through reload and live recipe changes', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  // The CLI bridge calls this same dispatch and serialized app.run owner.
  const dispatch = async (command, args = {}) => {
    const reply = await page.evaluate(([c, a]) => window.openlr.dispatch(c, a), [command, args])
    assert.equal(reply.ok, true, JSON.stringify(reply.error))
    return reply.result
  }
  const { added } = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 16
    canvas.getContext('2d').fillRect(0, 0, 16, 16)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve))
    return window.openlr.run('import', {
      files: ['legacy', 'original', 'linear', 'edited'].map(
        (name) => new File([blob], name + '.png', { type: 'image/png' })
      )
    })
  })
  await dispatch('select', { id: added[1] })
  await dispatch('processing', { version: 2 })
  await dispatch('processing', { version: 1 })
  for (const id of added.slice(2)) {
    await dispatch('select', { id })
    await dispatch('processing', { version: 2 })
  }
  await dispatch('edit', { key: 'Exposure', value: 0.5 })
  const recipes = new Map((await dispatch('state')).photos.map((photo) => [photo.id, photo.edit]))
  assert.deepEqual(
    added.map((id) => recipes.get(id)),
    [{}, { processVersion: 1 }, { processVersion: 2 }, { processVersion: 2, Exposure: 0.5 }]
  )
  const expectedRules = {},
    albumIds = {}
  for (const [name, edited, ids] of [
    ['Unedited', 'no', added.slice(0, 3)],
    ['Edited', 'yes', added.slice(3)]
  ]) {
    await dispatch('scope', { id: 'all' })
    await page.locator('#catalog-filters').evaluate((element) => (element.open = true))
    await page.getByLabel('Filter edits', { exact: true }).selectOption(edited)
    assert.equal((await dispatch('photos')).total, ids.length)
    await page.locator('#new-album').click()
    await page.locator('#album-name').fill(name)
    await page.locator('#smart-album').check()
    await page.locator('#album-dialog button[value="ok"]').click()
    await page.locator('#albums').getByRole('button', { name, exact: true }).waitFor()
    const state = await dispatch('state'),
      album = state.albums.find((album) => album.name === name)
    albumIds[name] = album.id
    expectedRules[name] = album.rule
    assert.deepEqual(album.rule, { rating: 0, flag: 'any', edited, text: '' })
    await dispatch('filter', { edited: 'any' })
    await page.locator(`#albums button[data-scope="${album.id}"]`).click()
    assert.deepEqual(new Set((await dispatch('photos')).photos.map((photo) => photo.id)), new Set(ids))
    assert.equal(await page.locator('#gallery .tile').count(), ids.length)
  }
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  for (const [name, count] of [
    ['Unedited', 3],
    ['Edited', 1]
  ]) {
    await page.locator(`#albums button[data-scope="${albumIds[name]}"]`).click()
    assert.equal((await dispatch('photos')).total, count)
    assert.deepEqual(
      (await dispatch('state')).albums.find((album) => album.id === albumIds[name]).rule,
      expectedRules[name]
    )
  }
  await dispatch('scope', { id: 'all' })
  await dispatch('select', { id: added[2] })
  await dispatch('edit', { key: 'Exposure', value: 0.25 })
  await dispatch('scope', { id: albumIds.Unedited })
  assert.equal((await dispatch('photos')).total, 2)
  await dispatch('scope', { id: albumIds.Edited })
  assert.equal((await dispatch('photos')).total, 2)
  await dispatch('select', { id: added[2] })
  await dispatch('reset')
  await dispatch('scope', { id: albumIds.Unedited })
  assert.equal((await dispatch('photos')).total, 3)
  const restored = (await dispatch('state')).photos.find((photo) => photo.id === added[2])
  assert.deepEqual(restored.edit, { processVersion: 2 })
})
