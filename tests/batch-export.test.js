import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'
import { saveExportSettingsBatch } from '../web/export-settings.js'
import { exportSelection } from '../web/batch-export.js'

const fixture = (offset) =>
  makePng({
    width: 48,
    height: 32,
    bits: 8,
    colorType: 2,
    srgb: 0,
    data: Array.from({ length: 48 * 32 * 3 }, (_, i) => 55 + offset + (Math.floor(i / 3) % 48) * 2)
  })
const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page.locator('#files').setInputFiles(
    ['b.png', 'a.png', 'c.png'].map((name, i) => ({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from(fixture(i * 20))
    }))
  )
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 3)
  await run(page, 'sort', { order: 'name', direction: 'asc' })
  // Only the native folder adapter is simulated. Decode, render, encoding,
  // dispatcher, GUI handlers and catalog are the actual browser application.
  await page.evaluate(() => {
    const state = (window.folderMock = {
      calls: [],
      files: [],
      transfers: new Map(),
      next: 0,
      failAt: 0,
      cancel: false
    })
    window.mygo = {
      call: async (method, ...args) => {
        state.calls.push([method, ...args])
        if (method === 'Desktop.BeginExportFolder')
          return state.cancel ? null : { id: 'folder', path: '/chosen' }
        if (method === 'Desktop.BeginFolderExport') {
          const id = String(++state.next),
            filename = args[1]
          state.transfers.set(id, { filename, chunks: [] })
          return { id, filename, path: '/chosen/' + filename }
        }
        if (method === 'Desktop.WriteExport') {
          if (state.failAt && state.files.length + 1 === state.failAt)
            throw Error('Simulated destination write failure')
          state.transfers.get(args[0]).chunks.push(Uint8Array.from(atob(args[1]), (c) => c.charCodeAt(0)))
          return
        }
        if (method === 'Desktop.FinishExport') {
          const item = state.transfers.get(args[0])
          state.files.push({
            filename: item.filename,
            bytes: Array.from(new Uint8Array(await new Blob(item.chunks).arrayBuffer()))
          })
          state.transfers.delete(args[0])
          return
        }
        if (method === 'Desktop.CancelExport') return state.transfers.delete(args[0])
        if (method === 'Desktop.EndExportFolder') {
          state.transfers.clear()
          return
        }
        throw Error('Unexpected desktop call: ' + method)
      }
    }
  })
  return page
}

test('batch export writes actual per-photo renders in visible order without changing active selection, recipes or previews', async (t) => {
  const page = await workspace(t)
  const result = await page.evaluate(async () => {
    const { run } = window.openlr,
      ids = (await run('photos')).photos.map((p) => p.id),
      expected = {}
    const options = {
      format: 'image/png',
      maxSize: 24,
      colorSpace: 'display-p3',
      outputSharpening: 'standard'
    }
    for (let i = 0; i < ids.length; i++) {
      await run('select', { id: ids[i] })
      await run('processing', { version: i === 1 ? 2 : 1 })
      await run('edit', { key: 'Exposure', value: i * 0.25 })
      const output = await run('export', options)
      expected[ids[i]] = Array.from(new Uint8Array(await output.blob.arrayBuffer()))
    }
    await run('select-many', { ids: [...ids].reverse() })
    await run('view', { mode: 'detail' })
    await run('compare')
    const before = await run('state'),
      preview = Array.from(new Uint8Array(await (await run('preview')).blob.arrayBuffer()))
    const batch = await run('export-selection', { ...options, outputDirectory: '/chosen' })
    const after = await run('state'),
      afterPreview = Array.from(new Uint8Array(await (await run('preview')).blob.arrayBuffer()))
    const { readPng } = await import('./png.js'),
      { makeColorProfile } = await import('./color-spaces.js')
    const decoded = window.folderMock.files.map((file) => {
      const png = readPng(Uint8Array.from(file.bytes))
      return { width: png.width, height: png.height, profile: Array.from(png.metadata.icc) }
    })
    return {
      ids,
      expected,
      batch,
      before,
      after,
      preview,
      afterPreview,
      files: window.folderMock.files,
      decoded,
      expectedProfile: Array.from(makeColorProfile('display-p3')),
      settings: await run('export-settings')
    }
  })
  assert.equal(result.batch.total, 3)
  assert.equal(result.batch.cancelled, false)
  assert.deepEqual(
    result.batch.files.map((file) => file.id),
    result.ids
  )
  for (let i = 0; i < result.files.length; i++) {
    assert.deepEqual(result.files[i].bytes, result.expected[result.ids[i]])
    assert.equal(result.batch.files[i].bytes, result.files[i].bytes.length)
    assert.deepEqual([result.decoded[i].width, result.decoded[i].height], [24, 16])
    assert.deepEqual(result.decoded[i].profile, result.expectedProfile)
  }
  assert.notDeepEqual(result.files[0].bytes, result.files[1].bytes)
  for (const key of ['selected', 'selection', 'photos', 'mode', 'compare'])
    assert.deepEqual(result.after[key], result.before[key], key)
  assert.deepEqual(result.afterPreview, result.preview)
  assert.equal(result.settings.photo.outputSharpening, 'standard')
  assert.equal(result.settings.photo.maxSize, 24)
})

test('batch export preflights targets and preserves previous settings on cancellation or partial write failure', async (t) => {
  const page = await workspace(t)
  await run(page, 'select-all')
  await run(page, 'export-settings', { media: 'photo', options: { format: 'image/jpeg', quality: 0.7 } })
  const before = await run(page, 'export-settings')
  const ids = (await run(page, 'photos')).photos.map((p) => p.id)
  for (const args of [
    { ids: [] },
    { ids: [ids[0], ids[0]] },
    { ids: ['missing'] },
    { format: 'video/mp4' }
  ]) {
    const response = await page.evaluate((args) => window.openlr.dispatch('export-selection', args), args)
    assert.equal(response.ok, false)
  }
  assert.equal(await page.evaluate(() => window.folderMock.calls.length), 0)
  await page.evaluate(() => {
    window.folderMock.cancel = true
  })
  const canceled = await run(page, 'export-selection', { format: 'image/png' })
  assert.equal(canceled.cancelled, true)
  assert.deepEqual(canceled.files, [])
  assert.deepEqual(await run(page, 'export-settings'), before)
  await page.evaluate(() => {
    window.folderMock.cancel = false
    window.folderMock.failAt = 2
  })
  const failed = await page.evaluate(() =>
    window.openlr.dispatch('export-selection', { format: 'image/png' })
  )
  assert.equal(failed.ok, false)
  assert.match(failed.error.message, /write failure/)
  assert.equal(failed.error.details.completed, 1)
  assert.equal(failed.error.details.total, 3)
  assert.equal(failed.error.details.failed.id, ids[1])
  assert.equal(failed.error.details.files.length, 1)
  assert.deepEqual(await run(page, 'export-settings'), before)
  const writes = await page.evaluate(() => ({
    files: window.folderMock.files,
    pending: window.folderMock.transfers.size,
    cancelled: window.folderMock.calls.some((call) => call[0] === 'Desktop.CancelExport')
  }))
  assert.equal(writes.files.length, 1)
  assert.equal(writes.pending, 0)
  assert.equal(writes.cancelled, true)
})

test('GUI multi-selection export and Export again share current recipes and persisted settings', async (t) => {
  const page = await workspace(t)
  await run(page, 'select-all')
  await page.locator('#export').click()
  await page.locator('#format').selectOption('image/png')
  await page.locator('#export-size').fill('20')
  await page.locator('#export-dialog button[value="ok"]').click()
  await waitForAsyncFunction(
    page,
    async () => (await window.openlr.run('export-settings')).photo?.maxSize === 20
  )
  assert.equal(await page.evaluate(() => window.folderMock.files.length), 3)
  const first = await page.evaluate(() => window.folderMock.files.map((file) => file.bytes))
  await run(page, 'edit', { key: 'Exposure', value: 0.8 })
  await page.locator('#export-previous').click()
  await waitForAsyncFunction(page, async () => {
    await window.openlr.run('state')
    return window.folderMock.files.length === 6
  })
  const second = await page.evaluate(() => window.folderMock.files.slice(3).map((file) => file.bytes))
  assert.equal(second.filter((bytes, i) => JSON.stringify(bytes) !== JSON.stringify(first[i])).length, 1)
  const state = await run(page, 'state')
  assert.equal(state.selection.length, 3)
  const originals = await page.evaluate(async () => {
    const { run } = window.openlr,
      rows = (await run('photos')).photos,
      originals = []
    for (const row of rows) {
      await run('select', { id: row.id })
      originals.push({
        name: row.name,
        bytes: Array.from(
          new Uint8Array(await (await run('export', { format: 'original' })).blob.arrayBuffer())
        )
      })
    }
    return originals
  })
  for (const original of originals)
    assert.deepEqual(
      original.bytes,
      Array.from(fixture(['b.png', 'a.png', 'c.png'].indexOf(original.name) * 20))
    )
})

test('mixed-media batch preserves originals and exports video stills at trimmed start without moving playback', async (t) => {
  const page = await workspace(t)
  const result = await page.evaluate(async () => {
    const m = await import('./vendor/mediabunny/mediabunny.mjs'),
      canvas = document.createElement('canvas')
    canvas.width = 48
    canvas.height = 32
    const context = canvas.getContext('2d'),
      target = new m.BufferTarget(),
      output = new m.Output({ target, format: new m.WebMOutputFormat() }),
      video = new m.CanvasSource(canvas, { codec: 'vp9', bitrate: 300000 })
    output.addVideoTrack(video)
    await output.start()
    for (let i = 0; i < 10; i++) {
      context.fillStyle = i < 5 ? '#d02020' : '#2020d0'
      context.fillRect(0, 0, 48, 32)
      await video.add(i / 10, 0.1)
    }
    await output.finalize()
    const inputBytes = Array.from(new Uint8Array(target.buffer)),
      { run } = window.openlr,
      imported = await run('import', {
        files: [new File([target.buffer], 'clip.webm', { type: 'video/webm' })]
      })
    if (imported.failed.length) throw Error(imported.failed[0].error)
    const id = imported.added[0]
    await run('video-trim', { start: 0.2, end: 0.8 })
    await run('video-seek', { time: 0.7 })
    await run('select-all')
    const before = await run('state'),
      original = await run('export-selection', { format: 'original' }),
      originalBytes = window.folderMock.files.find((file) => file.filename === 'clip.webm').bytes
    window.folderMock.files.length = 0
    const rendered = await run('export-selection', { format: 'image/png', maxSize: 24 }),
      still = window.folderMock.files.find((file) => file.filename === 'clip.png'),
      bitmap = await createImageBitmap(new Blob([Uint8Array.from(still.bytes)], { type: 'image/png' }))
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    return {
      before,
      after: await run('state'),
      original,
      originalBytes,
      inputBytes,
      rendered,
      dimensions: [canvas.width, canvas.height],
      color: Array.from(context.getImageData(4, 4, 1, 1).data),
      id
    }
  })
  assert.equal(result.original.files.length, 4)
  assert.equal(result.rendered.files.length, 4)
  assert.deepEqual(result.originalBytes, result.inputBytes)
  assert.deepEqual(result.dimensions, [24, 16])
  assert.ok(result.color[0] > result.color[2] * 3, JSON.stringify(result.color))
  for (const key of ['selected', 'selection', 'photos', 'playback'])
    assert.deepEqual(result.after[key], result.before[key], key)
})

test('batch settings replace media slots with one write and leave both intact when validation or storage fails', () => {
  const initial = JSON.stringify({
    photo: { format: 'image/png' },
    video: { format: 'video/webm', quality: 0.5 }
  })
  let value = initial,
    writes = 0,
    fail = false
  const storage = {
    getItem: (key) => (key === 'export-settings' ? value : null),
    setItem: (key, next) => {
      writes++
      if (fail) throw Error('Storage is full')
      assert.equal(key, 'export-settings')
      value = next
    }
  }
  const settings = [
    { media: 'photo', options: { format: 'original' } },
    { media: 'video', options: { format: 'original' } }
  ]
  assert.throws(
    () =>
      saveExportSettingsBatch([...settings, { media: 'photo', options: { format: 'video/mp4' } }], storage),
    /Select a video/
  )
  assert.equal(writes, 0)
  assert.equal(value, initial)
  fail = true
  assert.throws(() => saveExportSettingsBatch(settings, storage), /Storage is full/)
  assert.equal(writes, 1)
  assert.equal(value, initial)
  fail = false
  const saved = saveExportSettingsBatch(settings, storage)
  assert.equal(writes, 2)
  assert.deepEqual(saved, { photo: { format: 'original' }, video: { format: 'original' } })
  assert.deepEqual(JSON.parse(value), saved)
})

test('batch reports saved files when settings persistence fails and serialized edits cannot change an in-flight recipe', async (t) => {
  const page = await workspace(t)
  const result = await page.evaluate(async () => {
    const { run, dispatch } = window.openlr
    await run('select-all')
    await run('export-settings', { media: 'photo', options: { format: 'image/jpeg', quality: 0.6 } })
    const beforeSettings = await run('export-settings'),
      before = await run('state'),
      active = before.selected,
      options = { format: 'image/png', maxSize: 24 },
      reference = Array.from(new Uint8Array(await (await run('export', options)).blob.arrayBuffer())),
      setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'export-settings') throw Error('Simulated settings storage failure')
      return setItem.call(this, key, value)
    }
    let failure
    try {
      failure = await dispatch('export-selection', options)
    } finally {
      Storage.prototype.setItem = setItem
    }
    const afterSettings = await run('export-settings')
    window.folderMock.files.length = 0
    const batchPromise = run('export-selection', options),
      editPromise = run('edit', { key: 'Exposure', value: 1 })
    const batch = await batchPromise
    await editPromise
    const index = batch.files.findIndex((file) => file.id === active),
      exported = window.folderMock.files[index].bytes,
      changed = Array.from(new Uint8Array(await (await run('export', options)).blob.arrayBuffer()))
    return { failure, beforeSettings, afterSettings, batch, exported, reference, changed }
  })
  assert.equal(result.failure.ok, false)
  assert.match(result.failure.error.message, /settings storage failure/)
  assert.equal(result.failure.error.details.completed, 3)
  assert.equal(result.failure.error.details.files.length, 3)
  assert.equal(result.failure.error.details.failed, null)
  assert.deepEqual(result.afterSettings, result.beforeSettings)
  assert.equal(result.batch.files.length, 3)
  assert.deepEqual(result.exported, result.reference)
  assert.notDeepEqual(result.changed, result.reference)
})

test('batch folder rejection and cleanup preserve structured primary failure evidence', async () => {
  const visible = [1, 2].map((id) => ({ id: String(id), name: `photo-${id}.png`, edit: {} })),
    selection = new Set(visible.map((photo) => photo.id)),
    original = async () => ({ file: new Blob(['original']) }),
    prepare = async (photo) => ({ filename: photo.name, blob: new Blob(['encoded']) })
  await assert.rejects(
    exportSelection({
      visible,
      selection,
      args: { format: 'image/png' },
      original,
      prepare,
      reservedFolder: Promise.reject(Error('Folder permission denied'))
    }),
    (error) => {
      assert.match(error.message, /Folder permission denied/)
      assert.equal(error.details.completed, 0)
      assert.equal(error.details.total, 2)
      assert.deepEqual(error.details.files, [])
      return true
    }
  )
  await assert.rejects(
    exportSelection({
      visible,
      selection,
      args: { ids: ['missing'], format: 'image/png' },
      original,
      prepare,
      reservedFolder: Promise.reject(Error('Folder permission denied'))
    }),
    (error) => {
      assert.match(error.message, /unique photos from the current view/)
      assert.equal(error.details.completed, 0)
      assert.equal(error.details.total, 1)
      return true
    }
  )
  let writes = 0,
    closes = 0
  const folder = {
    async write(blob, filename) {
      if (++writes === 2) throw Error('Primary image write failure')
      return { filename, path: '/chosen/' + filename, bytes: blob.size }
    },
    async close() {
      closes++
      throw Error('Secondary cleanup failure')
    }
  }
  await assert.rejects(
    exportSelection({
      visible,
      selection,
      args: { format: 'image/png' },
      original,
      prepare,
      openFolder: async () => folder
    }),
    (error) => {
      assert.match(error.message, /Primary image write failure/)
      assert.equal(error.details.completed, 1)
      assert.equal(error.details.total, 2)
      assert.equal(error.details.failed.id, '2')
      assert.equal(error.details.files[0].id, '1')
      assert.equal(error.details.cleanupError, 'Secondary cleanup failure')
      return true
    }
  )
  assert.equal(writes, 2)
  assert.equal(closes, 1)
})
