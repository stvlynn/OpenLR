import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makeLrcat } from './fixtures/lrcat.mjs'
import { frame, png } from './fixtures/merge-scene.js'

test('synthetic Classic/Apple resource migration reviews explicit references, retries missing files, persists edits and syncs portable originals', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const original = png(frame(80, 60)),
    resources = new Map([
      ['Album/first.png', original],
      ['Album/second.png', original],
      ['Export album/apple.png', original],
      [
        'Export album/apple.xmp',
        Buffer.from(
          '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmp:Rating="5"><dc:subject><rdf:Bag><rdf:li>Exported keyword</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>'
        )
      ]
    ])
  const objects = new Map(),
    roots = [
      { id: 'fixture-root', name: 'Synthetic originals', path: 'C:/synthetic-authorized-only' },
      { id: 'apple-root', name: 'Synthetic Apple standard export', path: 'C:/synthetic-apple-export-only' }
    ],
    calls = []
  let serial = 0,
    reads = 0
  async function device(native) {
    const context = await browser.newContext(),
      page = await context.newPage()
    t.after(() => context.close())
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.exposeFunction('bridge', async (method, ...args) => {
      calls.push({ method, args })
      if (method === 'Local.Folders') return native ? roots : []
      if (method === 'Local.ChooseReferenceRoot') return roots[0]
      if (method === 'Local.ReferenceInfo') {
        if (!native || !roots.some((root) => root.id === args[0])) throw Error('unauthorized root')
        const bytes = resources.get(args[1])
        if (!bytes) throw Error('original not found')
        return { size: bytes.length, modified: 123456, name: args[1].split('/').at(-1), relative: args[1] }
      }
      if (method === 'Local.ExportedResources')
        return [...resources]
          .filter(([path]) => path.startsWith('Export album/'))
          .map(([path, bytes]) => ({
            name: path.split('/').at(-1),
            relative: path,
            size: bytes.length,
            modified: 123456
          }))
      if (method === 'Remote.Connect' || method === 'Remote.Disconnect' || method === 'Desktop.AgentChanged')
        return null
      const [key, etag, data] = args,
        stored = objects.get(key)
      if (method === 'Remote.Get') return stored ? { ...stored, status: 200 } : { status: 404 }
      if (method === 'Remote.Put') {
        if (etag === '*' ? stored : stored?.etag !== etag) return { status: 412 }
        objects.set(key, { data, etag: '"' + ++serial + '"' })
        return { status: 201 }
      }
      throw Error('Unexpected native bridge ' + method)
    })
    await page.addInitScript(() => {
      window.mygo = {
        platform: 'win32',
        call: (method, ...args) =>
          method === 'Desktop.AgentPoll' ? new Promise(() => {}) : window.bridge(method, ...args)
      }
    })
    await page.route('http://localphoto.localhost/**', (route) => {
      assert.equal(native, true, 'remote device must use its downloaded catalog originals')
      const path = new URL(route.request().url()).pathname
          .split('/')
          .slice(2)
          .map(decodeURIComponent)
          .join('/'),
        data = resources.get(path)
      reads++
      return route.fulfill({
        status: data ? 200 : 404,
        body: data ?? '',
        headers: { 'Access-Control-Allow-Origin': '*' },
        contentType: path.endsWith('.xmp') ? 'application/rdf+xml' : 'image/png'
      })
    })
    await page.goto(server.url)
    await page.waitForFunction(() => window.openlr)
    const run = (command, args = {}) =>
      page.evaluate(({ command, args }) => window.openlr.run(command, args), { command, args })
    return { page, run, errors }
  }
  const a = await device(true),
    catalog = await makeLrcat(),
    beforeReads = reads
  await a.page.locator('nav summary').filter({ hasText: 'Migrate photo catalogs' }).click()
  await a.page.getByRole('button', { name: 'Lightroom Classic catalog…', exact: true }).click()
  await a.page.getByLabel('Lightroom Classic catalog', { exact: true }).setInputFiles({
    name: 'synthetic.lrcat',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(catalog)
  })
  await a.page.waitForFunction(() =>
    document.querySelector('#migration-dialog output').textContent.includes('5 photo records')
  )
  assert.equal(reads, beforeReads, 'scan must not open catalog-referenced originals')
  const plans = await a.run('migration-report'),
    id = plans[0].id
  let report = await a.run('migration-inspect', { id })
  assert.equal(report.unmapped, 4)
  assert.equal(report.incomplete, 1)
  await assert.rejects(
    a.run('migration-map', { id, sourceRoot: '1', root: 'not-authorized' }),
    /not authorized/
  )
  await a.page.getByRole('button', { name: 'Choose matching folder…', exact: true }).click()
  await a.page.waitForFunction(() =>
    document.querySelector('#migration-dialog output').textContent.includes('3 available')
  )
  report = await a.run('migration-inspect', { id })
  assert.equal(report.originals, 3)
  assert.equal(report.availableOriginals, 2)
  assert.equal(report.missing, 1)
  await a.page.getByRole('button', { name: 'Migrate available originals', exact: true }).click()
  await a.page.waitForFunction(() =>
    document.querySelector('#migration-dialog output').textContent.includes('Imported 3;')
  )
  await a.page.getByRole('button', { name: 'Close', exact: true }).click()
  let state = await a.run('state'),
    first = state.photos.find((photo) => photo.migration.sourceId === '201'),
    copy = state.photos.find((photo) => photo.migration.sourceId === '203')
  assert.equal(state.photos.length, 3)
  assert.equal(first.rating, 4)
  assert.equal(first.flag, 'pick')
  assert.equal(first.keywords, 'Synthetic')
  assert.equal(first.edit.Exposure, 0.75)
  assert.equal(first.edit.Vibrance, 20)
  assert.equal(first.edit.Temperature, undefined)
  assert.equal(copy.originalId, first.id)
  assert.equal(first.reference.relative, 'Album/first.png')
  assert.equal(state.albums.length, 1)
  assert.equal(
    await a.page.evaluate(async () => {
      const { all } = await import('./catalog.js')
      return (await all('originals')).length
    }),
    0,
    'migration must retain original file references'
  )
  await a.run('select', { id: first.id })
  await a.run('edit', { key: 'Exposure', value: 1.1 })
  resources.set('Album/missing.png', original)
  report = await a.run('migration-retry', { id })
  assert.equal(report.imported.length, 1)
  assert.equal(report.existing.length, 3)
  assert.equal(report.missing.length, 1)
  await a.page.reload()
  await a.page.waitForFunction(() => window.openlr)
  state = await a.run('state')
  first = state.photos.find((photo) => photo.id === first.id)
  assert.equal(state.photos.length, 4)
  assert.equal(first.edit.Exposure, 1.1)
  const b = await device(false),
    endpoint = { endpoint: 'https://fixture.test/reviewed-sync/' }
  const uploaded = await a.run('sync', endpoint)
  assert.equal(uploaded.uploaded, 3, 'virtual copy shares one original asset')
  const manifest = JSON.parse(
    Buffer.from(objects.get('openlr-manifest.json').data, 'base64').toString('utf8')
  )
  assert.ok(
    Object.values(manifest.photos).every(
      (photo) => !photo.reference && !photo.local && !photo.migration?.sourcePath
    )
  )
  assert.equal(JSON.stringify(manifest).includes('C:/synthetic-authorized'), false)
  assert.equal((await b.run('sync', endpoint)).updated, 4)
  let remote = await b.run('state')
  assert.equal(remote.photos.length, 4)
  assert.ok(remote.photos.every((photo) => !photo.reference))
  assert.equal(remote.photos.find((photo) => photo.id === first.id).edit.Exposure, 1.1)
  await b.run('select', { id: copy.id })
  const preview = await b.page.evaluate(async () => {
    const { blob } = await window.openlr.run('preview', { maxSize: 40 })
    return blob.size
  })
  assert.ok(preview > 100)
  await b.run('edit', { key: 'Contrast', value: 12 })
  await b.run('sync', endpoint)
  await a.run('sync', endpoint)
  state = await a.run('state')
  assert.ok(state.photos.find((photo) => photo.id === copy.id).reference)
  assert.equal(state.photos.find((photo) => photo.id === copy.id).edit.Contrast, 12)
  const apple = await a.run('migration-apple-scan', { root: 'apple-root' })
  assert.equal(apple.total, 1)
  const appleCommit = await a.run('migration-commit', { id: apple.id })
  assert.equal(appleCommit.imported.length, 1)
  state = await a.run('state')
  const applePhoto = state.photos.find((photo) => photo.name === 'apple.png')
  assert.equal(applePhoto.rating, 5)
  assert.equal(applePhoto.keywords, 'Exported keyword')
  assert.ok(state.albums.some((album) => album.name === 'Export album'))
  assert.deepEqual(a.errors, [])
  assert.deepEqual(b.errors, [])
  assert.ok(
    calls
      .filter((call) => call.method === 'Local.ReferenceInfo')
      .every((call) => roots.some((root) => root.id === call.args[0]))
  )
})
