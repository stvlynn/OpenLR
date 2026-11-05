import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('two device libraries converge and concurrent edits require a choice before replacing either', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const objects = new Map()
  let serial = 0
  async function device() {
    const context = await browser.newContext(),
      page = await context.newPage()
    await page.exposeFunction('bridge', async (method, ...args) => {
      if (method === 'Local.Folders') return []
      if (method === 'Remote.Connect' || method === 'Remote.Disconnect') return null
      const [key, etag, data] = args,
        stored = objects.get(key)
      if (method === 'Remote.Get') return stored ? { ...stored, status: 200 } : { status: 404 }
      if (method === 'Remote.Put') {
        if (etag === '*' ? stored : stored?.etag !== etag) return { status: 412 }
        objects.set(key, { data, etag: '"' + ++serial + '"' })
        return { status: 201 }
      }
      throw Error('Unexpected bridge method')
    })
    await page.addInitScript(() => {
      window.mygo = {
        call: (method, ...args) =>
          method === 'Desktop.AgentPoll' ? new Promise(() => {}) : window.bridge(method, ...args)
      }
    })
    await page.goto(server.url)
    await page.waitForFunction(() => window.openlr)
    const run = (cmd, args = {}) => page.evaluate(([cmd, args]) => window.openlr.run(cmd, args), [cmd, args])
    return { page, run }
  }
  const a = await device(),
    b = await device(),
    url = { endpoint: 'https://example.test/library/' }
  await t.test('recipe transitions are atomic while compatible fields retain three-way merging', async () => {
    const results = await a.page.evaluate(async () => {
      const { reconcile } = await import('./sync.js')
      const manifest = (edit, extras = {}) => ({
        version: 1,
        photos: { p: { id: 'p', name: 'fixture.png', edit, ...extras } },
        albums: {},
        presets: {}
      })
      const baseline = manifest({ Exposure: 0, Contrast: 0 })
      const compatible = reconcile(
        baseline,
        manifest({ Exposure: 1, Contrast: 0 }),
        manifest({ Exposure: 0, Contrast: 9 })
      )
      const upgrade = manifest({ processVersion: 2, Exposure: 0, Contrast: 0 })
      const legacyEdit = manifest({ Exposure: 0, Contrast: 9 }, { rating: 4 })
      const transition = reconcile(baseline, upgrade, legacyEdit)
      const remoteChoice = reconcile(baseline, upgrade, legacyEdit, 'remote')
      const bothUpgrade = reconcile(
        baseline,
        upgrade,
        manifest({ processVersion: 2, Exposure: 1, Contrast: 0 })
      )
      const cleanUpgrade = reconcile(baseline, baseline, upgrade)
      const linearBaseline = manifest({ processVersion: 2, Exposure: 0, Contrast: 0 })
      const linearMerge = reconcile(
        linearBaseline,
        manifest({ processVersion: 2, Exposure: 1, Contrast: 0 }),
        manifest({ processVersion: 2, Exposure: 0, Contrast: 9 })
      )
      const downgrade = reconcile(
        linearBaseline,
        manifest({ processVersion: 1, Exposure: 0, Contrast: 0 }),
        manifest({ processVersion: 2, Exposure: 0, Contrast: 9 })
      )
      const explicitLegacy = reconcile(
        baseline,
        manifest({ Exposure: 1, Contrast: 0 }),
        manifest({ processVersion: 1, Exposure: 0, Contrast: 9 })
      )
      const named = reconcile(
        manifest({}),
        manifest({}, { versions: [{ id: 'v', edit: { processVersion: 2 } }] }),
        manifest({})
      )
      const preset = manifest({})
      preset.presets.x = { id: 'x', edit: { processVersion: 2 } }
      const presetMerge = reconcile(manifest({}), preset, manifest({}))
      const promoted = manifest({})
      promoted.version = 2
      return {
        compatible,
        transition,
        remoteChoice,
        bothUpgrade,
        cleanUpgrade,
        linearMerge,
        downgrade,
        explicitLegacy,
        named,
        presetMerge,
        retained: reconcile(promoted, manifest({}), manifest({}))
      }
    })
    assert.deepEqual(results.compatible.next.photos.p.edit, { Exposure: 1, Contrast: 9 })
    assert.deepEqual(results.compatible.conflicts, [])
    assert.deepEqual(results.transition.conflicts[0].fields, ['edit'])
    assert.deepEqual(results.transition.next.photos.p.edit, { processVersion: 2, Exposure: 0, Contrast: 0 })
    assert.equal(results.transition.next.photos.p.rating, 4)
    assert.deepEqual(results.remoteChoice.next.photos.p.edit, { Exposure: 0, Contrast: 9 })
    assert.deepEqual(results.bothUpgrade.conflicts[0].fields, ['edit'])
    assert.deepEqual(results.cleanUpgrade.conflicts, [])
    assert.deepEqual(results.linearMerge.conflicts, [])
    assert.deepEqual(results.linearMerge.next.photos.p.edit, { processVersion: 2, Exposure: 1, Contrast: 9 })
    assert.deepEqual(results.downgrade.conflicts[0].fields, ['edit'])
    assert.deepEqual(results.downgrade.next.photos.p.edit, { processVersion: 1, Exposure: 0, Contrast: 0 })
    assert.deepEqual(results.explicitLegacy.conflicts, [])
    assert.deepEqual(results.explicitLegacy.next.photos.p.edit, {
      processVersion: 1,
      Exposure: 1,
      Contrast: 9
    })
    assert.equal(results.cleanUpgrade.next.version, 2)
    assert.equal(results.named.next.version, 2)
    assert.equal(results.presetMerge.next.version, 2)
    assert.equal(results.retained.next.version, 2)
  })
  await a.page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 32
    c.height = 24
    const blob = await new Promise((cb) => c.toBlob(cb, 'image/png'))
    await window.openlr.run('import', { files: [new File([blob], 'shared.png', { type: 'image/png' })] })
  })
  await a.run('rate', { value: 2 })
  assert.equal((await a.run('sync', url)).uploaded, 1)
  assert.equal((await b.run('sync', url)).updated, 1)
  assert.equal((await b.run('state')).photos[0].rating, 2)
  await a.run('rate', { value: 4 })
  await b.run('rate', { value: 5 })
  await a.run('sync', url)
  const conflict = await b.run('sync', url)
  assert.equal(conflict.synced, false)
  assert.equal(conflict.conflicts[0].name, 'shared.png')
  assert.equal((await b.run('state')).photos[0].rating, 5)
  await b.run('sync', { ...url, prefer: 'remote' })
  assert.equal((await b.run('state')).photos[0].rating, 4)
  assert.equal((await b.run('sync', url)).uploaded, 0)
  assert.equal(objects.size, 2)
  await t.test(
    'a process transition conflicts with concurrent legacy edits and survives reload',
    async () => {
      const id = (await a.run('state')).photos[0].id
      await a.run('select', { id })
      await b.run('select', { id })
      await a.run('processing', { version: 2 })
      await a.run('edit', { key: 'Exposure', value: 1 })
      await b.run('edit', { key: 'Contrast', value: 20 })
      await b.run('rate', { value: 3 })
      assert.equal((await a.run('sync', url)).synced, true)
      const remoteBefore = objects.get('openlr-manifest.json')
      const manifest = JSON.parse(Buffer.from(remoteBefore.data, 'base64').toString())
      assert.equal(manifest.version, 2)
      assert.equal(manifest.photos[id].edit.processVersion, 2)
      const conflict = await b.run('sync', url)
      assert.equal(conflict.synced, false)
      assert.deepEqual(conflict.conflicts[0].fields, ['edit'])
      assert.equal(objects.get('openlr-manifest.json').etag, remoteBefore.etag)
      assert.equal((await b.run('state')).photos[0].edit.Contrast, 20)
      await b.page.reload()
      await b.page.waitForFunction(() => window.openlr)
      const persisted = (await b.run('state')).photos[0]
      assert.equal(persisted.edit.processVersion, undefined)
      assert.equal(persisted.edit.Contrast, 20)
      assert.equal((await b.run('sync', url)).synced, false)
      assert.equal((await b.run('sync', { ...url, prefer: 'remote' })).synced, true)
      await b.page.reload()
      await b.page.waitForFunction(() => window.openlr)
      const chosen = (await b.run('state')).photos[0]
      assert.equal(chosen.edit.processVersion, 2)
      assert.equal(chosen.edit.Exposure, 1)
      assert.equal(chosen.edit.Contrast, undefined)
      assert.equal(chosen.rating, 3)
      assert.equal((await b.run('sync', url)).synced, true)
      assert.equal((await a.run('sync', url)).synced, true)
      await a.run('edit', { key: 'Exposure', value: 2 })
      await b.run('select', { id })
      await b.run('edit', { key: 'Contrast', value: 10 })
      await a.run('sync', url)
      const merged = await b.run('sync', url)
      assert.equal(merged.synced, true)
      assert.deepEqual(merged.conflicts, [])
      await b.page.reload()
      await b.page.waitForFunction(() => window.openlr)
      const compatible = (await b.run('state')).photos[0].edit
      assert.equal(compatible.processVersion, 2)
      assert.equal(compatible.Exposure, 2)
      assert.equal(compatible.Contrast, 10)
      assert.equal(objects.size, 2)
    }
  )
  await t.test('unsupported remote process versions fail before changing a library or baseline', async () => {
    const previous = objects.get('openlr-manifest.json')
    const baseline = await b.page.evaluate(async (endpoint) => {
      const db = await import('./catalog.js')
      return db.transaction('sync', 'readonly', (tx) => tx.objectStore('sync').get(endpoint))
    }, url.endpoint)
    const current = (await b.run('state')).photos[0].edit
    const id = Object.keys(JSON.parse(Buffer.from(previous.data, 'base64').toString()).photos)[0]
    for (const mutate of [
      (manifest) => {
        manifest.version = 3
      },
      (manifest) => {
        manifest.version = 1
      },
      (manifest) => {
        manifest.photos[id].edit.processVersion = 3
      },
      (manifest) => {
        manifest.photos[id].versions = [{ id: 'v', edit: { processVersion: 3 } }]
      },
      (manifest) => {
        manifest.presets.x = { id: 'x', edit: { processVersion: 3 } }
      }
    ]) {
      const manifest = JSON.parse(Buffer.from(previous.data, 'base64').toString())
      mutate(manifest)
      const corrupt = { ...previous, data: Buffer.from(JSON.stringify(manifest)).toString('base64') }
      objects.set('openlr-manifest.json', corrupt)
      await assert.rejects(b.run('sync', url), /Unsupported|newer manifest/)
      assert.deepEqual((await b.run('state')).photos[0].edit, current)
      assert.equal(objects.get('openlr-manifest.json'), corrupt)
      const retained = await b.page.evaluate(async (endpoint) => {
        const db = await import('./catalog.js')
        return db.transaction('sync', 'readonly', (tx) => tx.objectStore('sync').get(endpoint))
      }, url.endpoint)
      assert.deepEqual(retained, baseline)
    }
    objects.set('openlr-manifest.json', previous)
  })
})
