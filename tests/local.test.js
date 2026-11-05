import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('local adapter browses references, preserves edits on reopen, and reuses image export without catalog originals', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.addInitScript(() => {
    const root = { id: 'authorized-root', name: 'Local fixtures', path: 'test-fixtures' }
    let recipe = {}
    globalThis.localTest = { writes: [] }
    const listing = (relative) => ({
      root,
      relative: relative || '.',
      directories: relative === 'sub' ? [] : [{ name: 'sub', relative: 'sub' }],
      photos:
        relative === 'sub'
          ? []
          : [{ name: 'photo #1.png', relative: 'photo #1.png', size: 200, modified: 1234567, recipe }]
    })
    globalThis.mygo = {
      platform: 'win32',
      call: async (method, ...args) => {
        if (method === 'Desktop.AgentPoll') return new Promise(() => {})
        if (method === 'Local.Folders') return [root]
        if (method === 'Local.ChooseFolder') return listing('.')
        if (method === 'Local.OpenFolder') return listing(args[1])
        if (method === 'Local.SaveRecipe') {
          recipe = JSON.parse(args[2])
          globalThis.localTest.writes.push(args)
          return
        }
        throw Error('Unexpected native call ' + method)
      }
    }
  })
  await page.goto(server.url)
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 80
    canvas.height = 60
    const c = canvas.getContext('2d')
    c.fillStyle = '#456'
    c.fillRect(0, 0, 80, 60)
    return canvas.toDataURL().split(',')[1]
  })
  let photoReads = 0
  await page.route('http://localphoto.localhost/**', (route) => {
    photoReads++
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: Buffer.from(png, 'base64')
    })
  })
  await page.waitForFunction(() => Boolean(globalThis.openlr))
  const run = (command, args = {}) =>
    page.evaluate(([command, args]) => globalThis.openlr.run(command, args), [command, args])
  assert.equal((await run('local-open')).photos, 1)
  assert.equal((await run('state')).local.root.id, 'authorized-root')
  await run('view', { mode: 'detail' })
  await run('edit', { key: 'Exposure', value: 1 })
  await run('edit', { key: 'turn', value: 1 })
  await run('rate', { value: 4 })
  assert.ok(photoReads > 0)
  const count = await page.evaluate(async () => {
    const { all } = await import('./catalog.js')
    return (await all('originals')).length
  })
  assert.equal(count, 0, 'local originals must never be copied into IndexedDB')
  assert.equal(await page.evaluate(() => globalThis.localTest.writes.length), 3)
  const image = await page.evaluate(async () => {
    const { blob } = await globalThis.openlr.run('export', { format: 'image/png' })
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  const output = Buffer.from(image)
  assert.equal(output.readUInt32BE(16), 60)
  assert.equal(output.readUInt32BE(20), 80)
  const original = await page.evaluate(async () => {
    const { blob } = await globalThis.openlr.run('export', { format: 'original' })
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  assert.deepEqual(Buffer.from(original), Buffer.from(png, 'base64'))
  await run('local-browse', { relative: 'sub' })
  assert.equal((await run('state')).photos.length, 0)
  await run('local-open', { root: 'authorized-root' })
  const state = await run('state')
  assert.equal(state.photos[0].edit.Exposure, 1)
  assert.equal(state.photos[0].edit.turn, 1)
  assert.equal(state.photos[0].rating, 4)
  await run('library')
  assert.equal((await run('state')).local, null)
  assert.equal((await run('state')).photos.length, 0)
})

test('local adapter preserves sidecar presence and processing versions and refuses unsupported snapshots', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const adapter = await import('./local.js')
    const root = { id: 'fixture-root', name: 'Fixtures', path: 'test-fixtures' }
    const entries = [
      { name: 'new.png', sidecarPresent: false, recipe: {} },
      { name: 'historical.png', sidecarPresent: true, recipe: {} },
      {
        name: 'linear.png',
        sidecarPresent: true,
        recipe: {
          edit: { processVersion: 2, Exposure: 0.25 },
          rating: 4,
          keywords: 'fixture',
          versions: [
            { id: 'old', edit: {} },
            { id: 'linear', edit: { processVersion: 2 } }
          ]
        }
      },
      { name: 'future.png', sidecarPresent: true, recipe: { edit: { processVersion: 3 } } },
      { name: 'snapshot.png', sidecarPresent: true, recipe: { versions: [{ edit: { processVersion: 99 } }] } }
    ]
    const writes = []
    globalThis.mygo = {
      call: async (method, ...args) => {
        if (method === 'Local.Folders') return [root]
        if (method === 'Local.OpenFolder')
          return {
            root,
            relative: '.',
            directories: [],
            photos: entries.map((entry) => ({ ...entry, relative: entry.name, modified: 1, size: 10 }))
          }
        if (method === 'Local.SaveRecipe') {
          writes.push(JSON.parse(args[2]))
          return
        }
        throw Error('Unexpected call ' + method)
      }
    }
    const opened = await adapter.open(root.id)
    const edits = structuredClone(opened.photos.slice(0, 3).map((photo) => photo.edit))
    await adapter.save(opened.photos[2])
    const errors = []
    for (const photo of opened.photos.slice(3)) {
      try {
        await adapter.save(photo)
      } catch (error) {
        errors.push(error.message)
      }
    }
    const img = document.createElement('img')
    adapter.observeThumbnail(opened.photos[3], img, () => {
      throw Error('Unsupported thumbnail was rendered')
    })
    opened.photos[0].edit = { processVersion: 7 }
    try {
      await adapter.save(opened.photos[0])
    } catch (error) {
      errors.push(error.message)
    }
    return {
      presence: opened.photos.map((photo) => photo.local.sidecarPresent),
      edits,
      writes,
      errors,
      warnings: opened.warnings,
      thumbnailError: img.title
    }
  })
  assert.deepEqual(result.presence, [false, true, true, true, true])
  assert.deepEqual(result.edits, [{}, {}, { processVersion: 2, Exposure: 0.25 }])
  assert.equal(result.writes.length, 1)
  assert.equal(result.writes[0].rating, 4)
  assert.equal(result.writes[0].keywords, 'fixture')
  assert.deepEqual(result.writes[0].versions, [
    { id: 'old', edit: {} },
    { id: 'linear', edit: { processVersion: 2 } }
  ])
  assert.equal(result.errors.length, 3)
  assert.ok(result.errors.every((message) => /processing version/.test(message)))
  assert.equal(result.warnings.length, 2)
  assert.match(result.thumbnailError, /processing version/)
})
