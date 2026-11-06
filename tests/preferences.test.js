import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'

test('preferences migrate once and acknowledge only committed catalog settings', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  t.diagnostic('Chrome ' + browser.version())
  const page = await browser.newPage()
  t.after(() => page.close())
  await page.route(server.url + '/seed', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Fixture</title>' })
  )
  await page.goto(server.url + '/seed')
  await page.evaluate(async () => {
    localStorage.setItem(
      'openlr.preferences',
      JSON.stringify({ filenames: false, extensions: false, shortcuts: true, autoAdvance: false })
    )
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('openlr', 5)
      request.onupgradeneeded = () => request.result.createObjectStore('albums', { keyPath: 'id' })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction('albums', 'readwrite')
      tx.objectStore('albums').put({ id: 'preserved', name: 'Preserved album' })
      tx.oncomplete = resolve
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  })
  await page.addInitScript(() => {
    if (sessionStorage.getItem('preferences-load-held')) return
    sessionStorage.setItem('preferences-load-held', 'true')
    const original = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (names, mode, options) {
      const tx = original.call(this, names, mode, options)
      if ((Array.isArray(names) ? names : [names]).includes('settings') && mode === 'readonly') {
        IDBDatabase.prototype.transaction = original
        Object.defineProperty(tx, 'oncomplete', {
          set(handler) {
            tx.addEventListener('complete', (event) => {
              window.releasePreferenceLoad = () => handler.call(tx, event)
            })
          }
        })
      }
      return tx
    }
  })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page.waitForFunction(() => window.releasePreferenceLoad)
  await page.locator('#settings').click()
  assert.equal(await page.locator('#preferences').evaluate((dialog) => dialog.open), false)
  await page.evaluate(() => window.releasePreferenceLoad())
  await page.waitForFunction(() => document.getElementById('preferences').open)
  assert.equal(await page.locator('#preferences input[name="filenames"]').isChecked(), false)
  await page.evaluate(() => document.getElementById('preferences').close())
  const run = (command, args = {}) =>
    page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args])
  const migrated = { autoAdvance: false, filenames: false, extensions: false, shortcuts: true }
  assert.deepEqual(await run('preferences'), migrated)
  assert.ok((await run('state')).albums.some((album) => album.id === 'preserved'))
  const record = () => page.evaluate(async () => (await import('/catalog.js')).readSetting('preferences'))
  assert.deepEqual((await record()).values, migrated)
  await page.evaluate(() => {
    localStorage.setItem('openlr.preferences', JSON.stringify({ filenames: true, extensions: true }))
  })
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  assert.deepEqual(await run('preferences'), migrated)

  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction
    window.restoreSettingsTransaction = () => {
      IDBDatabase.prototype.transaction = original
    }
    IDBDatabase.prototype.transaction = function (names, mode, options) {
      const tx = original.call(this, names, mode, options)
      if ((Array.isArray(names) ? names : [names]).includes('settings') && mode === 'readwrite') {
        window.settingsDurability = tx.durability
        queueMicrotask(() => tx.abort())
      }
      return tx
    }
  })
  await assert.rejects(() => run('preferences', { filenames: true }))
  assert.equal(await page.evaluate(() => window.settingsDurability), 'strict')
  assert.deepEqual(await run('preferences'), migrated)
  assert.deepEqual((await record()).values, migrated)
  await page.locator('#settings').click()
  await page.locator('#preferences input[name="filenames"]').evaluate((input) => {
    input.addEventListener('change', (event) => {
      window.preferenceAttempt = { trusted: event.isTrusted, checked: input.checked }
    })
  })
  await page.locator('#preferences input[name="filenames"]').click()
  assert.deepEqual(await page.evaluate(() => window.preferenceAttempt), { trusted: true, checked: true })
  await waitForAsyncFunction(page, async () => Boolean(document.getElementById('notice').textContent))
  assert.deepEqual(await run('preferences'), migrated)
  assert.equal(await page.locator('#preferences input[name="filenames"]').isChecked(), false)
  await page.evaluate(() => {
    window.restoreSettingsTransaction()
    document.getElementById('preferences').close()
  })
  const saved = { ...migrated, filenames: true, autoAdvance: true }
  assert.deepEqual(await run('preferences', { filenames: true, autoAdvance: true }), saved)
  assert.deepEqual((await record()).values, saved)
  await assert.rejects(() => run('preferences', { filenames: 'false' }), /boolean/i)
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  assert.deepEqual(await run('preferences'), saved)
  await page.locator('#settings').click()
  assert.equal(await page.locator('#preferences input[name="filenames"]').isChecked(), true)
  assert.equal(await page.locator('#preferences input[name="extensions"]').isChecked(), false)
})
