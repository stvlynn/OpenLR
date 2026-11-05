import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'
import { makeDng } from './fixtures/dng.mjs'
import { ExportProgress } from '../web/export-progress.js'
import { exportSelection } from '../web/batch-export.js'

const run = (page, command, args = {}) =>
  page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args])

test('live export controls bypass queued edits, cancel the current transfer and retain saved files', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  const png = Buffer.from(
    makePng({
      width: 32,
      height: 24,
      bits: 8,
      colorType: 2,
      srgb: 0,
      data: new Uint8Array(32 * 24 * 3).fill(95)
    })
  )
  await page
    .locator('#files')
    .setInputFiles(['a.png', 'b.png', 'c.png'].map((name) => ({ name, mimeType: 'image/png', buffer: png })))
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 3)
  await run(page, 'sort', { order: 'name', direction: 'asc' })
  await run(page, 'select-all')
  await run(page, 'export-settings', { media: 'photo', options: { format: 'image/tiff', maxSize: 11 } })
  const before = await run(page, 'state')
  await page.evaluate(() => {
    const state = (window.progressMock = {
      files: [],
      transfers: new Map(),
      next: 0,
      held: false,
      cancelled: [],
      editDone: false
    })
    window.mygo = {
      async call(method, ...args) {
        if (method === 'Desktop.BeginExportFolder') return { id: 'folder', path: '/export' }
        if (method === 'Desktop.BeginFolderExport') {
          const id = String(++state.next)
          state.transfers.set(id, { filename: args[1], chunks: [] })
          return { id, filename: args[1], path: '/export/' + args[1] }
        }
        if (method === 'Desktop.WriteExport') {
          state.transfers.get(args[0]).chunks.push(Uint8Array.from(atob(args[1]), (c) => c.charCodeAt(0)))
          if (state.next === 2) {
            state.held = true
            await new Promise((resolve) => (state.release = resolve))
          }
          return
        }
        if (method === 'Desktop.FinishExport') {
          const file = state.transfers.get(args[0])
          state.files.push({
            filename: file.filename,
            bytes: Array.from(new Uint8Array(await new Blob(file.chunks).arrayBuffer()))
          })
          state.transfers.delete(args[0])
          return
        }
        if (method === 'Desktop.CancelExport') {
          state.cancelled.push(args[0])
          state.transfers.delete(args[0])
          return
        }
        if (method === 'Desktop.EndExportFolder') {
          state.transfers.clear()
          return
        }
        throw Error('Unexpected ' + method)
      }
    }
    window.batchPending = window.openlr
      .run('export-selection', { format: 'original' })
      .then((result) => (state.result = result))
  })
  await page.waitForFunction(() => window.progressMock.held)
  const live = await run(page, 'export-status')
  assert.equal(live.status, 'running')
  assert.equal(live.phase, 'writing')
  assert.equal(live.total, 3)
  assert.equal(live.completed, 1)
  assert.equal(live.current.name, 'b.png')
  assert.equal(live.files.length, 1)
  assert.equal(live.files[0].filename, 'a.png')
  assert.equal(live.totalBytes, png.length)
  await page.screenshot({ path: '.workspace/export-progress.png' })
  await page.evaluate(() => {
    window.queuedEdit = window.openlr
      .run('edit', { key: 'Exposure', value: 0.7 })
      .then(() => (window.progressMock.editDone = true))
  })
  assert.equal((await run(page, 'export-status')).id, live.id)
  assert.equal(await page.evaluate(() => window.progressMock.editDone), false)
  await assert.rejects(() => run(page, 'export-cancel', { id: 'stale-job' }), /not found/)
  await page.locator('#export-cancel').click()
  assert.equal((await run(page, 'export-status')).status, 'cancelling')
  assert.equal((await run(page, 'export-cancel', { id: live.id })).status, 'cancelling')
  await page.evaluate(() => window.progressMock.release())
  await waitForAsyncFunction(page, async () => {
    await window.batchPending
    await window.queuedEdit
    return window.progressMock.result !== undefined
  })
  const final = await run(page, 'export-status'),
    after = await run(page, 'state'),
    settings = await run(page, 'export-settings')
  const observed = await page.evaluate(() => ({
    result: window.progressMock.result,
    files: window.progressMock.files,
    pending: window.progressMock.transfers.size,
    cancelled: window.progressMock.cancelled
  }))
  assert.equal(final.id, live.id)
  assert.equal(final.status, 'cancelled')
  assert.equal(final.completed, 1)
  assert.equal(observed.result.cancelled, true)
  assert.equal(observed.result.jobId, live.id)
  assert.equal(observed.result.files.length, 1)
  assert.deepEqual(observed.cancelled, ['2'])
  assert.equal(observed.pending, 0)
  assert.equal(observed.files.length, 1)
  assert.deepEqual(observed.files[0].bytes, Array.from(png))
  assert.deepEqual(settings.photo, { format: 'image/tiff', colorSpace: 'srgb', maxSize: 11 })
  assert.deepEqual(after.selection, before.selection)
  assert.equal(after.selected, before.selected)
  assert.equal(after.photos.find((photo) => photo.id === after.selected).edit.Exposure, 0.7)
  assert.equal((await run(page, 'export-cancel', { id: live.id })).status, 'cancelled')
  assert.equal(await page.locator('#export-cancel').isVisible(), false)
})

function domainExport(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    remembered = JSON.stringify({
      photo: { format: 'image/png', maxSize: 19 },
      video: { format: 'video/webm' }
    }),
    storage = {
      value: remembered,
      writes: 0,
      getItem(key) {
        return key === 'export-settings' ? this.value : null
      },
      setItem(key, value) {
        assert.equal(key, 'export-settings')
        this.value = value
        this.writes++
      }
    }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  })
  const progress = new ExportProgress(),
    visible = ['a', 'b'].map((id) => ({ id, name: id + '.png', edit: {}, mediaType: 'image/png' }))
  return {
    progress,
    storage,
    remembered,
    options: {
      progress,
      visible,
      selection: new Set(['a', 'b']),
      args: { format: 'original' },
      original: async () => {
        throw Error('Unexpected original lookup')
      },
      prepare: async (photo) => ({ blob: new Blob([photo.id]), filename: photo.name })
    }
  }
}

test('late publication cancellation counts its committed file without remembering settings and stale IDs cannot cancel the next job', async (t) => {
  const { progress, storage, remembered, options } = domainExport(t)
  const result = await exportSelection({
    ...options,
    openFolder: async () => ({
      async write(blob, filename) {
        progress.cancel(progress.snapshot().id)
        return { path: '/out/' + filename, filename, bytes: blob.size }
      },
      async close() {}
    })
  })
  assert.equal(result.cancelled, true)
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].id, 'a')
  assert.equal(progress.snapshot().completed, 1)
  assert.equal(progress.snapshot().status, 'cancelled')
  assert.equal(storage.writes, 0)
  assert.equal(storage.value, remembered)
  const forged = progress.snapshot()
  forged.files[0].filename = 'forged'
  forged.completed = 99
  assert.equal(progress.snapshot().files[0].filename, 'a.png')
  assert.equal(progress.snapshot().completed, 1)
  const next = progress.start(2)
  assert.notEqual(next.id, result.jobId)
  assert.throws(() => progress.cancel(result.jobId), /not found/)
  assert.equal(next.signal.aborted, false)
  assert.equal(progress.snapshot().completed, 0)
  assert.deepEqual(progress.snapshot().files, [])
  progress.cancel(next.id)
  progress.finish('cancelled')
})

test('a real write error racing cancellation remains failed with its completed file and source identity', async (t) => {
  const { progress, storage, remembered, options } = domainExport(t)
  let writes = 0
  await assert.rejects(
    () =>
      exportSelection({
        ...options,
        openFolder: async () => ({
          async write(blob, filename) {
            if (++writes === 1) return { path: '/out/' + filename, filename, bytes: blob.size }
            progress.cancel(progress.snapshot().id)
            throw Object.assign(Error('Destination disconnected'), {
              cleanupError: 'Transfer cleanup unavailable'
            })
          },
          async close() {}
        })
      }),
    (error) => {
      assert.match(error.message, /Destination disconnected/)
      assert.equal(error.details.completed, 1)
      assert.equal(error.details.total, 2)
      assert.equal(error.details.files[0].id, 'a')
      assert.deepEqual(error.details.failed, { id: 'b', name: 'b.png' })
      assert.equal(error.details.cleanupError, 'Transfer cleanup unavailable')
      return true
    }
  )
  assert.equal(progress.snapshot().status, 'failed')
  assert.equal(progress.snapshot().completed, 1)
  assert.equal(storage.writes, 0)
  assert.equal(storage.value, remembered)
})

test('failed cleanup after cooperative cancellation is a failed job rather than a clean cancellation', async (t) => {
  const { progress, storage, options } = domainExport(t)
  await assert.rejects(
    () =>
      exportSelection({
        ...options,
        openFolder: async () => ({
          async write(blob, filename, { signal }) {
            progress.cancel(progress.snapshot().id)
            signal.throwIfAborted()
          },
          async close() {
            throw Error('Folder cleanup unavailable')
          }
        })
      }),
    (error) => {
      assert.match(error.message, /Folder cleanup unavailable/)
      assert.equal(error.details.completed, 0)
      assert.deepEqual(error.details.files, [])
      assert.deepEqual(error.details.failed, { id: 'a', name: 'a.png' })
      return true
    }
  )
  assert.equal(progress.snapshot().status, 'failed')
  assert.equal(storage.writes, 0)
})

test('throwing progress observers report errors without stranding output or the next job', async (t) => {
  const { storage, options } = domainExport(t),
    previous = Object.getOwnPropertyDescriptor(globalThis, 'reportError'),
    observed = [],
    observerFailure = Error('Observer render failed')
  Object.defineProperty(globalThis, 'reportError', {
    configurable: true,
    value: (error) => observed.push(error)
  })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'reportError', previous)
    else delete globalThis.reportError
  })
  const progress = new ExportProgress(() => {
    throw observerFailure
  })
  const result = await exportSelection({
    ...options,
    progress,
    openFolder: async () => ({
      async write(blob, filename) {
        return { path: '/out/' + filename, filename, bytes: blob.size }
      },
      async close() {}
    })
  })
  assert.equal(result.cancelled, false)
  assert.equal(result.files.length, 2)
  assert.equal(progress.snapshot().status, 'completed')
  assert.equal(storage.writes, 1)
  assert.ok(observed.length > 0)
  assert.ok(observed.every((error) => error === observerFailure))
  const next = progress.start(1)
  assert.notEqual(next.id, result.jobId)
  progress.cancel(next.id)
  progress.finish('cancelled')
  assert.equal(progress.snapshot().status, 'cancelled')
})

test('cancelling during the last DNG preflight does not open a destination or prepare output', async (t) => {
  const { progress, storage, options } = domainExport(t),
    source = new File([makeDng({ width: 16, height: 16 })], 'source.dng', { type: 'image/x-adobe-dng' }),
    readIds = []
  let opened = false,
    prepared = false
  const result = await exportSelection({
    ...options,
    args: { format: 'image/x-adobe-dng' },
    async original(id) {
      readIds.push(id)
      if (id === 'b') progress.cancel(progress.snapshot().id)
      return { file: source }
    },
    async prepare() {
      prepared = true
      throw Error('Preparation must not run after cancellation')
    },
    async openFolder() {
      opened = true
      throw Error('Destination must not open after cancellation')
    }
  })
  assert.deepEqual(readIds, ['a', 'b'])
  assert.equal(opened, false)
  assert.equal(prepared, false)
  assert.equal(result.cancelled, true)
  assert.deepEqual(result.files, [])
  assert.equal(progress.snapshot().status, 'cancelled')
  assert.equal(progress.snapshot().completed, 0)
  assert.equal(storage.writes, 0)
})
