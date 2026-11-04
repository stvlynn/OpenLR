import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

test('model cache supports Blob-incompatible hosts, legacy records and atomic chunk replacement', async (t) => {
  const server = createServer(async (req, res) => {
    try {
      const file = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html'
      if (file.includes('..')) throw Error()
      res.setHeader('Content-Type', /\.m?js$/.test(file) ? 'text/javascript' : 'text/html')
      res.end(await readFile(new URL('../web/' + file, import.meta.url)))
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:' + server.address().port)
  const result = await page.evaluate(async () => {
    const { cachedModel } = await import('./ai-runtime.js'),
      nativePut = IDBObjectStore.prototype.put,
      nativeFetch = window.fetch
    let downloads = 0
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (value instanceof Blob || value?.bytes instanceof Blob)
        throw Error('Error preparing Blob/File data to be stored in object store')
      return nativePut.call(this, value, ...args)
    }
    const getKeys = async () => {
      const db = await new Promise((resolve) => {
        const request = indexedDB.open('openlr-models')
        request.onsuccess = () => resolve(request.result)
      })
      try {
        return await new Promise((resolve) => {
          const request = db.transaction('weights').objectStore('weights').getAllKeys()
          request.onsuccess = () => resolve(request.result)
        })
      } finally {
        db.close()
      }
    }
    window.fetch = async () => {
      downloads++
      const bytes = new Uint8Array(downloads === 1 ? 20 * 1024 * 1024 : 7)
      bytes[0] = 23
      bytes[bytes.length - 1] = 89
      return new Response(bytes)
    }
    try {
      const first = new Uint8Array(await cachedModel({ url: 'fixed-rev-1', revision: '1' }, 'test')),
        again = new Uint8Array(await cachedModel({ url: 'fixed-rev-1', revision: '1' }, 'test')),
        keys = await getKeys(),
        firstDownloads = downloads
      await cachedModel({ url: 'fixed-rev-2', revision: '2' }, 'test')
      const replaced = await getKeys()
      const db = await new Promise((resolve) => {
        const request = indexedDB.open('openlr-models')
        request.onsuccess = () => resolve(request.result)
      })
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('weights', 'readwrite'),
          store = transaction.objectStore('weights')
        nativePut.call(store, { url: 'legacy-blob', bytes: new Blob([Uint8Array.from([1, 2, 3])]) }, 'legacy')
        nativePut.call(store, { url: 'legacy-array', bytes: Uint8Array.from([4, 5]).buffer }, 'array')
        transaction.oncomplete = resolve
        transaction.onerror = () => reject(transaction.error)
      })
      db.close()
      return {
        length: first.length,
        boundaries: [first[0], again.at(-1)],
        keys,
        firstDownloads,
        replaced,
        downloads,
        blob: [...new Uint8Array(await cachedModel({ url: 'legacy-blob' }, 'legacy'))],
        array: [...new Uint8Array(await cachedModel({ url: 'legacy-array' }, 'array'))]
      }
    } finally {
      IDBObjectStore.prototype.put = nativePut
      window.fetch = nativeFetch
    }
  })
  assert.equal(result.length, 20 * 1024 * 1024)
  assert.deepEqual(result.boundaries, [23, 89])
  assert.deepEqual(result.keys, ['test', 'test:0', 'test:1'])
  assert.equal(result.firstDownloads, 1)
  assert.deepEqual(result.replaced, ['test', 'test:0'])
  assert.equal(result.downloads, 2)
  assert.deepEqual(result.blob, [1, 2, 3])
  assert.deepEqual(result.array, [4, 5])
})
