import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('140 MiB media survives Blob rejection, bounded chunk records, reopen, metadata reuse and atomic abort', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.addInitScript(() => {
    globalThis.rejectStoredBlob = true
    globalThis.catalogStorageAttempts = { blobs: 0, largeArrays: 0, largestArray: 0 }
    const inspect = (value) => {
      if (value instanceof Blob && globalThis.rejectStoredBlob) {
        globalThis.catalogStorageAttempts.blobs++
        throw new DOMException('Blob storage unsupported in this simulated WebKit store', 'DataCloneError')
      }
      if (value instanceof ArrayBuffer) {
        globalThis.catalogStorageAttempts.largestArray = Math.max(
          globalThis.catalogStorageAttempts.largestArray,
          value.byteLength
        )
        if (value.byteLength > 16 * 1024 * 1024) {
          globalThis.catalogStorageAttempts.largeArrays++
          throw new DOMException('Single ArrayBuffer record exceeds simulated engine limit', 'DataCloneError')
        }
        return
      }
      if (value && typeof value === 'object') for (const child of Object.values(value)) inspect(child)
    }
    for (const method of ['add', 'put']) {
      const native = IDBObjectStore.prototype[method]
      IDBObjectStore.prototype[method] = function (value, ...args) {
        inspect(value)
        return native.call(this, value, ...args)
      }
    }
  })
  await page.goto(server.url)
  const stored = await page.evaluate(async () => {
    const db = await import('./catalog.js'),
      unit = new Uint8Array(1024 * 1024)
    for (let index = 0; index < unit.length; index++) unit[index] = index % 251
    const tail = Uint8Array.from({ length: 17 }, (_, index) => 200 + index),
      file = new File([...Array(140).fill(unit), tail], 'large-fixture.bin', {
        type: 'application/octet-stream',
        lastModified: 123456789
      })
    const thumbnail = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'], {
      type: 'image/svg+xml'
    })
    const photo = {
      id: 'large',
      name: file.name,
      width: 1,
      height: 1,
      added: 1,
      rating: 0,
      flag: '',
      keywords: '',
      deleted: false,
      albums: [],
      edit: {},
      thumbnail
    }
    await db.addPhoto(photo, file)
    const raw = await db.transaction('originals', 'readonly', (tx) =>
      tx.objectStore('originals').get('large')
    )
    const keys = await db.transaction('media', 'readonly', (tx) => tx.objectStore('media').getAllKeys())
    const loaded = (await db.all('photos'))[0]
    await db.save('photos', { ...loaded, rating: 4 })
    await db.save('photos', { ...loaded, id: 'virtual', originalId: 'large' })
    const after = await db.transaction('media', 'readonly', (tx) => tx.objectStore('media').getAllKeys())
    let aborted = false
    try {
      await db.addPhoto(
        { ...photo, thumbnail: new Blob(['replacement']) },
        new File([new Uint8Array(10 * 1024 * 1024)], 'replacement.bin')
      )
    } catch {
      aborted = true
    }
    const final = await db.transaction('media', 'readonly', (tx) => tx.objectStore('media').getAllKeys())
    return {
      size: file.size,
      count: raw.file.count,
      storage: raw.file.storage,
      chunkBytes: db.MEDIA_CHUNK_BYTES,
      keys: keys.length,
      after: after.length,
      final: final.length,
      aborted,
      attempts: globalThis.catalogStorageAttempts
    }
  })
  assert.equal(stored.size, 140 * 1024 * 1024 + 17)
  assert.equal(stored.storage, 'chunks-v2')
  assert.equal(stored.count, 18)
  assert.equal(stored.attempts.blobs, 0)
  assert.equal(stored.attempts.largeArrays, 0)
  assert.ok(stored.attempts.largestArray <= stored.chunkBytes)
  assert.equal(stored.after, stored.keys, 'rating and virtual copy must reuse stored media')
  assert.equal(stored.aborted, true)
  assert.equal(stored.final, stored.keys, 'aborted replacement must leave no orphan chunks')
  await page.reload()
  const restored = await page.evaluate(async () => {
    const db = await import('./catalog.js'),
      { file } = await db.original('large')
    let valid = true
    for (let offset = 0; offset < 140 * 1024 * 1024; offset += 1024 * 1024) {
      const bytes = new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer())
      for (let index = 0; index < bytes.length; index++)
        if (bytes[index] !== index % 251) {
          valid = false
          break
        }
    }
    const tail = [...new Uint8Array(await file.slice(-17).arrayBuffer())]
    return { valid, tail, size: file.size, name: file.name, type: file.type, modified: file.lastModified }
  })
  assert.equal(restored.valid, true)
  assert.deepEqual(
    restored.tail,
    Array.from({ length: 17 }, (_, index) => 200 + index)
  )
  assert.equal(restored.size, stored.size)
  assert.equal(restored.name, 'large-fixture.bin')
  assert.equal(restored.type, 'application/octet-stream')
  assert.equal(restored.modified, 123456789)
  const legacy = await page.evaluate(async () => {
    const db = await import('./catalog.js')
    globalThis.rejectStoredBlob = false
    await db.transaction('originals', 'readwrite', (tx) => {
      tx.objectStore('originals').put({
        id: 'legacy-blob',
        file: new File(['legacy blob'], 'old.raw', { type: 'image/x-test', lastModified: 123 })
      })
      tx.objectStore('originals').put({
        id: 'legacy-bytes',
        file: {
          storage: 'bytes-v1',
          bytes: new TextEncoder().encode('legacy bytes').buffer,
          type: 'image/x-test',
          name: 'old-ab.raw',
          modified: 456
        }
      })
    })
    const blob = await db.original('legacy-blob'),
      bytes = await db.original('legacy-bytes')
    const cached = (await db.all('photos'))[0]
    await db.transaction('photos', 'readwrite', (tx) => {
      for (const id of ['large', 'virtual']) db.deleteRecord(tx, 'photos', id)
    })
    // Another tab/sync may reclaim a reference while this tab still holds a Blob.
    await db.save('photos', { ...cached, id: 'resurrected' })
    const recovered = (await db.all('photos'))[0]
    if (
      (await recovered.thumbnail.text()) !== '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'
    )
      throw Error('Reclaimed cached thumbnail was not restored')
    await db.transaction(['photos', 'originals'], 'readwrite', (tx) => {
      for (const id of ['large', 'virtual', 'resurrected']) db.deleteRecord(tx, 'photos', id)
      db.deleteRecord(tx, 'originals', 'large')
    })
    const chunks = await db.transaction('media', 'readonly', (tx) => tx.objectStore('media').getAllKeys())
    return {
      blob: await blob.file.text(),
      bytes: await bytes.file.text(),
      name: bytes.file.name,
      modified: bytes.file.lastModified,
      chunks: chunks.length
    }
  })
  assert.deepEqual(legacy, {
    blob: 'legacy blob',
    bytes: 'legacy bytes',
    name: 'old-ab.raw',
    modified: 456,
    chunks: 0
  })
})
