import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makeLrcat } from './fixtures/lrcat.mjs'
import { frame, png } from './fixtures/merge-scene.js'
import { makeDng } from './fixtures/dng.mjs'
import { embedPngMetadata } from '../web/color-containers.js'
import { buildExportMetadata } from '../web/export-metadata.js'
import UTIF from '../web/vendor/codecs/utif.js'

test('synthetic Classic/Apple resource migration reviews explicit references, retries missing files, persists edits and syncs portable originals', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const original = png(frame(80, 60)),
    embeddedDate = '2021-02-03T04:05:06Z',
    appleDate = '2017-10-03T12:34:56-07:00',
    datedOriginal = Buffer.from(
      embedPngMetadata(
        original,
        buildExportMetadata(
          { DateTimeOriginal: embeddedDate },
          {
            policy: 'supported',
            width: 80,
            height: 60
          }
        )
      )
    ),
    sidecar = (date) =>
      Buffer.from(
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:p="http://ns.adobe.com/photoshop/1.0/" xmp:Rating="5"><dc:subject><rdf:Seq><rdf:li>Exported keyword</rdf:li></rdf:Seq></dc:subject><p:DateCreated>' +
          date +
          '</p:DateCreated></rdf:Description></rdf:RDF></x:xmpmeta>'
      ),
    resources = new Map([
      ['Album/first.png', original],
      ['Album/second.png', original],
      ['Export album/apple.png', datedOriginal],
      ['Export album/apple.xmp', sidecar(appleDate)]
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
    copy = state.photos.find((photo) => photo.migration.sourceId === '203'),
    rotated = state.photos.find((photo) => photo.migration.sourceId === '205')
  assert.equal(state.photos.length, 3)
  assert.equal(first.rating, 4)
  assert.equal(first.flag, 'pick')
  assert.equal(first.keywords, 'Synthetic')
  assert.equal(first.edit.Exposure, 0.75)
  assert.equal(first.edit.Vibrance, 20)
  assert.equal(first.edit.Temperature, undefined)
  assert.deepEqual(first.edit.crop, { x: 0.25, y: 0.125, w: 0.5, h: 0.75 })
  assert.equal(copy.originalId, first.id)
  assert.deepEqual(copy.edit.crop, { x: 0.125, y: 0, w: 0.75, h: 1 })
  assert.equal(rotated.edit.crop, undefined)
  assert.ok(rotated.migration.warnings.includes('Unsupported or rotated catalog crop; not applied'))
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
  assert.equal(state.photos.find((photo) => photo.migration.sourceId === '202').edit.crop, undefined)
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
    const image = await createImageBitmap(blob),
      dimensions = [image.width, image.height]
    image.close()
    return dimensions
  })
  assert.deepEqual(preview, [40, 40])
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
  assert.equal(applePhoto.metadata.DateTimeOriginal, appleDate)
  assert.ok(state.albums.some((album) => album.name === 'Export album'))

  // This is a generated standard export folder, not an actual Photos library.
  const raw = Buffer.from(makeDng()),
    linearXmp = await a.page.evaluate(async () =>
      (await import('./xmp.js')).exportXmp({ edit: { processVersion: 2, Exposure: -0.5 } })
    )
  resources.set('Export album/linear.dng', raw)
  resources.set('Export album/linear.xmp', Buffer.from(linearXmp))
  resources.set('Export album/future.png', original)
  resources.set(
    'Export album/future.xmp',
    Buffer.from(linearXmp.replace('&quot;processVersion&quot;:2', '&quot;processVersion&quot;:3'))
  )
  resources.set('Export album/foreign.png', original)
  resources.set('Export album/foreign.xmp', Buffer.from('<invalid-foreign-sidecar'))
  resources.set('Export album/partial-date.png', datedOriginal)
  resources.set('Export album/partial-date.xmp', sidecar('2016-10'))
  resources.set(
    'Export album/video.webm',
    Buffer.from('Not a video: reject linear processing before poster decoding')
  )
  resources.set('Export album/video.xmp', Buffer.from(linearXmp))
  const linearScan = await a.run('migration-apple-scan', { root: 'apple-root' }),
    linearCommit = await a.run('migration-commit', { id: linearScan.id })
  assert.equal(linearScan.total, 6)
  assert.equal(linearCommit.imported.length, 3)
  assert.equal(linearCommit.existing.length, 1)
  assert.equal(linearCommit.failed.length, 2)
  assert.match(
    linearCommit.failed.find((photo) => photo.name === 'future.png').error,
    /Unsupported photo processing version/
  )
  assert.match(linearCommit.failed.find((photo) => photo.name === 'video.webm').error, /still photos/)
  state = await a.run('state')
  assert.equal(
    state.photos.some((photo) => photo.name === 'future.png'),
    false
  )
  assert.equal(
    state.photos.some((photo) => photo.name === 'video.webm'),
    false
  )
  const linearPhoto = state.photos.find((photo) => photo.name === 'linear.dng'),
    foreignPhoto = state.photos.find((photo) => photo.name === 'foreign.png'),
    partialPhoto = state.photos.find((photo) => photo.name === 'partial-date.png')
  assert.deepEqual(linearPhoto.edit, { processVersion: 2, Exposure: -0.5 })
  assert.deepEqual(foreignPhoto.edit, {})
  assert.ok(foreignPhoto.migration.warnings.some((warning) => /XMP: Invalid XMP document/.test(warning)))
  assert.equal(partialPhoto.metadata.DateTimeOriginal, embeddedDate)
  assert.equal(partialPhoto.keywords, 'Exported keyword')
  assert.ok(partialPhoto.migration.warnings.includes('XMP: Invalid or incomplete capture date'))
  await a.run('sort', { order: 'capture', direction: 'asc' })
  const ordered = (await a.run('state')).photos.map(({ id }) => id)
  assert.ok(ordered.indexOf(applePhoto.id) < ordered.indexOf(partialPhoto.id))
  await a.run('select', { id: applePhoto.id })
  await a.run('capture-time', { time: '2024-01-01T00:00:00Z' })
  await a.run('migration-retry', { id: linearScan.id })
  const revisedApple = (await a.run('state')).photos.find(({ id }) => id === applePhoto.id)
  assert.equal(revisedApple.metadata.DateTimeOriginal, '2024-01-01T00:00:00.000Z')
  await a.run('select', { id: linearPhoto.id })
  await a.run('view', { mode: 'detail' })
  const linearImages = await a.page.evaluate(async (id) => {
    const { all } = await import('./catalog.js'),
      photo = (await all('photos')).find((photo) => photo.id === id)
    const read = async (blob) => {
      const image = await createImageBitmap(blob),
        canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const paint = canvas.getContext('2d', { willReadFrequently: true })
      paint.drawImage(image, 0, 0)
      image.close()
      return {
        width: canvas.width,
        height: canvas.height,
        data: Array.from(paint.getImageData(0, 0, canvas.width, canvas.height).data)
      }
    }
    const preview = await read((await window.openlr.run('preview')).blob),
      jpeg = document.createElement('canvas')
    jpeg.width = preview.width
    jpeg.height = preview.height
    jpeg
      .getContext('2d')
      .putImageData(new ImageData(Uint8ClampedArray.from(preview.data), preview.width, preview.height), 0, 0)
    return {
      thumbnail: await read(photo.thumbnail),
      thumbnailReference: await read(
        await new Promise((resolve) => jpeg.toBlob(resolve, 'image/jpeg', 0.92))
      ),
      preview,
      rendered: await read((await window.openlr.run('export', { format: 'image/png' })).blob),
      tiff: Array.from(
        new Uint8Array(await (await window.openlr.run('export', { format: 'image/tiff' })).blob.arrayBuffer())
      ),
      original: Array.from(
        new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
      )
    }
  }, linearPhoto.id)
  assert.equal(linearImages.thumbnail.width, linearImages.preview.width)
  assert.equal(linearImages.thumbnail.height, linearImages.preview.height)
  assert.equal(
    linearImages.thumbnail.data.filter(
      (value, index) => value !== linearImages.thumbnailReference.data[index]
    ).length,
    0,
    'The stored JPEG thumbnail must match the linear preview after the same terminal JPEG encoding'
  )
  assert.deepEqual(linearImages.rendered, linearImages.preview)
  assert.ok(linearImages.preview.data.some((value, index) => index % 4 !== 3 && value > 0 && value < 255))
  assert.deepEqual(UTIF.decode(Uint8Array.from(linearImages.tiff).buffer)[0].t258, [16, 16, 16, 16])
  assert.deepEqual(Buffer.from(linearImages.original), raw)
  await a.page.reload()
  await a.page.waitForFunction(() => window.openlr)
  assert.deepEqual(
    (await a.run('state')).photos.find((photo) => photo.id === linearPhoto.id).edit,
    linearPhoto.edit
  )
  await a.run('select', { id: linearPhoto.id })
  const reloaded = await a.page.evaluate(async () => {
    const bitmap = await createImageBitmap((await window.openlr.run('preview')).blob),
      canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const paint = canvas.getContext('2d', { willReadFrequently: true })
    paint.drawImage(bitmap, 0, 0)
    bitmap.close()
    return {
      width: canvas.width,
      height: canvas.height,
      data: Array.from(paint.getImageData(0, 0, canvas.width, canvas.height).data)
    }
  })
  assert.deepEqual(reloaded, linearImages.preview)
  assert.deepEqual(a.errors, [])
  assert.deepEqual(b.errors, [])
  assert.ok(
    calls
      .filter((call) => call.method === 'Local.ReferenceInfo')
      .every((call) => roots.some((root) => root.id === call.args[0]))
  )
})
