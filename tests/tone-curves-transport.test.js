import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  return page
}

test('XMP, persisted presets and remote sync reject malformed curve owners before committing records', async (t) => {
  const page = await workspace(t)
  const result = await page.evaluate(async () => {
    const { exportXmp, readXmp } = await import('./xmp.js')
    const { Presets } = await import('./presets.js')
    const db = await import('./catalog.js')
    const { synchronize } = await import('./sync.js')
    const invalid = {
      rgb: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.9 },
        { x: 0.5, y: 0.1 },
        { x: 1, y: 1 }
      ]
    }
    const rejected = async (fn) => {
      try {
        await fn()
        return ''
      } catch (error) {
        return error.message
      }
    }
    const xmp = await rejected(() => readXmp(exportXmp({ edit: { toneCurves: invalid }, keywords: '' })))
    const presets = new Presets()
    const create = await rejected(() => presets.create('Invalid', { toneCurves: invalid }))
    const afterCreate = await db.all('presets')
    await db.save('presets', { id: 'bad', name: 'Malformed stored fixture', edit: { toneCurves: invalid } })
    await presets.load()
    const get = await rejected(() => presets.get('bad'))
    await db.transaction('presets', 'readwrite', (tx) => tx.objectStore('presets').delete('bad'))
    const calls = []
    const failures = []
    for (const kind of ['photo', 'snapshot', 'preset']) {
      const manifest = { version: 1, photos: {}, albums: {}, presets: {} }
      if (kind === 'preset') manifest.presets.remote = { id: 'remote', edit: { toneCurves: invalid } }
      else
        manifest.photos.remote = {
          id: 'remote',
          name: 'generated.png',
          edit: kind === 'photo' ? { toneCurves: invalid } : {},
          ...(kind === 'snapshot' ? { versions: [{ id: 'v', edit: { toneCurves: invalid } }] } : {})
        }
      const data = btoa(JSON.stringify(manifest))
      failures.push(
        await rejected(() =>
          synchronize({ endpoint: 'https://fixture.invalid/library/' }, async (method, key) => {
            calls.push({ kind, method, key })
            if (method === 'Connect' || method === 'Disconnect') return
            if (method === 'Get' && key === 'openlr-manifest.json')
              return { status: 200, data, etag: 'fixture' }
            throw Error('Unexpected fixture transfer')
          })
        )
      )
    }
    return {
      xmp,
      create,
      afterCreate,
      get,
      failures,
      calls,
      photos: await db.all('photos'),
      presets: await db.all('presets'),
      sync: await db.all('sync')
    }
  })
  for (const error of [result.xmp, result.create, result.get, ...result.failures])
    assert.match(error, /Curve points/)
  assert.deepEqual(result.afterCreate, [])
  assert.deepEqual(result.photos, [])
  assert.deepEqual(result.presets, [])
  assert.deepEqual(result.sync, [])
  assert.equal(result.calls.filter((call) => call.method === 'Get').length, 3)
  assert.equal(result.calls.filter((call) => call.method === 'Disconnect').length, 3)
  assert.ok(result.calls.every((call) => ['Connect', 'Get', 'Disconnect'].includes(call.method)))
})

test('malformed local curves remain visibly blocked without breaking the grid or overwriting their sidecar', async (t) => {
  const page = await workspace(t)
  const result = await page.evaluate(async () => {
    const local = await import('./local.js')
    const root = { id: 'curves', name: 'Generated fixtures' }
    let entries = [
      { name: 'historical.png', relative: 'historical.png', recipe: { edit: null }, sidecarPresent: true }
    ]
    const writes = []
    window.mygo = {
      platform: 'win32',
      call: async (method, ...args) => {
        if (method === 'Local.Folders') return [root]
        if (method === 'Local.OpenFolder') return { root, relative: '.', directories: [], photos: entries }
        if (method === 'Local.SaveRecipe') {
          writes.push(args)
          return
        }
        throw Error('Unexpected local fixture request')
      }
    }
    const historical = await local.open(root.id)
    const neutral = [
      { x: 0, y: 0 },
      { x: 0.4, y: 0.4 },
      { x: 1, y: 1 }
    ]
    entries = [
      {
        name: 'invalid.png',
        relative: 'invalid.png',
        recipe: {
          edit: {
            toneCurves: {
              rgb: [
                { x: 0, y: 0 },
                { x: 0, y: 0.8 },
                { x: 1, y: 1 }
              ]
            }
          },
          versions: [{ id: 'neutral', edit: { toneCurves: { red: neutral } } }]
        },
        sidecarPresent: true
      }
    ]
    const opened = await window.openlr.run('local-open', { root: root.id })
    const state = await window.openlr.run('state')
    const commandErrors = []
    for (const [command, args] of [
      ['curve-channel', { channel: 'red' }],
      ['curve-select', { index: 0 }],
      [
        'curve-set',
        {
          channel: 'rgb',
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 }
          ]
        }
      ]
    ]) {
      try {
        await window.openlr.run(command, args)
        commandErrors.push('')
      } catch (error) {
        commandErrors.push(error.message)
      }
    }
    await window.openlr.run('filter', { edited: 'yes' })
    const filtered = await window.openlr.run('state')
    let saveError = ''
    try {
      await local.save((await local.open(root.id)).photos[0])
    } catch (error) {
      saveError = error.message
    }
    return {
      historicalWarnings: historical.warnings,
      historicalEdit: historical.photos[0].edit,
      opened,
      state,
      commandErrors,
      filtered,
      saveError,
      writes,
      tiles: document.querySelectorAll('#gallery .tile').length,
      notice: document.querySelector('#notice').textContent,
      curveDisabled: document.querySelector('#curve-channel').disabled
    }
  })
  assert.deepEqual(result.historicalWarnings, [])
  assert.deepEqual(result.historicalEdit, {})
  assert.equal(result.opened.warnings.length, 1)
  assert.match(result.opened.warnings[0].error, /Curve points/)
  assert.equal(result.tiles, 1)
  assert.equal(result.curveDisabled, true)
  for (const message of result.commandErrors) assert.match(message, /Curve points/)
  assert.deepEqual(result.filtered.toneCurve, result.state.toneCurve)
  assert.equal(result.filtered.photos.length, 1)
  assert.match(result.notice, /Curve points/)
  assert.match(result.saveError, /repair or remove/)
  assert.deepEqual(result.writes, [])
  assert.equal(result.state.photos[0].edit.toneCurves.rgb[1].x, 0)
})
