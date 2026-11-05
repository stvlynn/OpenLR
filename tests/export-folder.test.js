import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('browser folder sink writes real files sequentially and aborts without deleting raced files', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const { beginExportFolder } = await import('/desktop.js')
    const directory = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('exports', { create: true })
    const original = await directory.getFileHandle('PHOTO.png', { create: true })
    const originalStream = await original.createWritable()
    await originalStream.write('original')
    await originalStream.close()
    window.showDirectoryPicker = async () => directory
    const sink = await beginExportFolder()
    const outputs = []
    for (const name of ['photo.png', 'photo.png', '../旅行.png', 'CON.png'])
      outputs.push(await sink.write(new Blob([name]), name))
    await sink.close()
    let closedError
    try {
      await sink.write(new Blob(['later']), 'later.png')
    } catch (error) {
      closedError = error.message
    }
    window.showDirectoryPicker = async () => ({
      name: directory.name,
      keys: () => directory.keys(),
      removeEntry: (name) => directory.removeEntry(name),
      async getFileHandle(name, options) {
        const file = await directory.getFileHandle(name, options)
        return {
          async createWritable() {
            const stream = await file.createWritable()
            return {
              async write(blob) {
                await stream.write(blob)
                throw Error('Injected disk failure')
              },
              close: () => stream.close(),
              abort: () => stream.abort()
            }
          }
        }
      }
    })
    const failing = await beginExportFolder()
    let failure
    try {
      await failing.write(new Blob(['partial']), 'failed.png')
    } catch (error) {
      failure = error.message
    }
    await failing.close()
    let removed = false
    window.showDirectoryPicker = async () => ({
      name: directory.name,
      keys: () => directory.keys(),
      async removeEntry() {
        removed = true
      },
      async getFileHandle(name, options) {
        const file = await directory.getFileHandle(name, options)
        const external = await file.createWritable()
        await external.write('concurrent writer')
        await external.close()
        return {
          async createWritable() {
            throw Error('Injected open failure')
          }
        }
      }
    })
    const raced = await beginExportFolder()
    let raceFailure
    try {
      await raced.write(new Blob(['export']), 'race.png')
    } catch (error) {
      raceFailure = error.message
    }
    await raced.close()
    const files = {}
    for await (const [name, handle] of directory.entries())
      files[name] = await (await handle.getFile()).text()
    window.showDirectoryPicker = async () => {
      throw new DOMException('Canceled', 'AbortError')
    }
    const canceled = await beginExportFolder()
    let pathError
    try {
      await beginExportFolder('/unavailable/native/path')
    } catch (error) {
      pathError = error.message
    }
    return { outputs, files, closedError, failure, canceled, pathError, removed, raceFailure }
  })
  assert.deepEqual(
    result.outputs.map((file) => file.filename),
    ['photo-2.png', 'photo-3.png', '旅行.png', '_CON.png']
  )
  assert.deepEqual(result.files, {
    'PHOTO.png': 'original',
    'photo-2.png': 'photo.png',
    'photo-3.png': 'photo.png',
    '旅行.png': '../旅行.png',
    '_CON.png': 'CON.png',
    'failed.png': '',
    'race.png': 'concurrent writer'
  })
  assert.match(result.closedError, /closed/)
  assert.equal(result.failure, 'Injected disk failure')
  assert.equal(result.raceFailure, 'Injected open failure')
  assert.equal(result.removed, false)
  assert.equal(result.canceled, null)
  assert.match(result.pathError, /desktop/)
  for (const output of result.outputs) assert.ok(output.bytes > 0)
})

test('folder cancellation stops uncommitted chunks, reports bytes and preserves commit acknowledgements', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const { beginExportFolder, writeNativeExport } = await import('/desktop.js'),
      size = 1024 * 1024 + 13,
      blob = new Blob([new Uint8Array(size).fill(73)]),
      directory = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle('cancel-exports', { create: true })
    window.showDirectoryPicker = async () => directory
    const sink = await beginExportFolder(),
      early = new AbortController(),
      middle = new AbortController()
    early.abort()
    let earlyError, middleError
    try {
      await sink.write(blob, 'early.bin', { signal: early.signal })
    } catch (error) {
      earlyError = error.name
    }
    const progress = []
    try {
      await sink.write(blob, 'middle.bin', {
        signal: middle.signal,
        onProgress(value) {
          progress.push(value)
          if (value.writtenBytes) middle.abort()
        }
      })
    } catch (error) {
      middleError = error.name
    }
    const completeProgress = []
    const completed = await sink.write(blob, 'complete.bin', {
      onProgress: (value) => completeProgress.push(value)
    })
    const entries = {}
    for await (const [name, handle] of directory.entries()) entries[name] = (await handle.getFile()).size
    const completeBytes = new Uint8Array(
      await (await (await directory.getFileHandle('complete.bin')).getFile()).arrayBuffer()
    )
    await sink.close()
    const late = new AbortController()
    window.showDirectoryPicker = async () => ({
      name: directory.name,
      keys: () => directory.keys(),
      async getFileHandle(name, options) {
        const file = await directory.getFileHandle(name, options)
        return {
          async createWritable() {
            const stream = await file.createWritable()
            return {
              write: (chunk) => stream.write(chunk),
              abort: () => stream.abort(),
              async close() {
                await stream.close()
                late.abort()
              }
            }
          }
        }
      }
    })
    const lateSink = await beginExportFolder(),
      lateSaved = await lateSink.write(blob, 'late.bin', { signal: late.signal })
    await lateSink.close()
    const calls = [],
      nativeController = new AbortController()
    window.mygo = {
      async call(method, ...args) {
        calls.push([method, ...args])
        if (method === 'Desktop.CancelExport') throw Error('Cleanup unavailable')
      }
    }
    let nativeFailure
    try {
      await writeNativeExport(blob, 'partial', {
        signal: nativeController.signal,
        onProgress(value) {
          if (value.writtenBytes) nativeController.abort()
        }
      })
    } catch (error) {
      nativeFailure = { name: error.name, cleanup: error.cleanupError }
    }
    const lateBegin = new AbortController(),
      beginCalls = []
    window.mygo = {
      async call(method, ...args) {
        beginCalls.push(method)
        if (method === 'Desktop.BeginExportFolder') return { id: 'folder', path: '/exports' }
        if (method === 'Desktop.BeginFolderExport') {
          lateBegin.abort()
          return { id: 'late-transfer', filename: 'late.bin', path: '/exports/late.bin' }
        }
      }
    }
    const beginSink = await beginExportFolder('/exports')
    let beginError
    try {
      await beginSink.write(blob, 'late.bin', { signal: lateBegin.signal })
    } catch (error) {
      beginError = error.name
    }
    await beginSink.close()
    const nativeLate = new AbortController(),
      commitCalls = []
    window.mygo = {
      async call(method, ...args) {
        commitCalls.push(method)
        if (method === 'Desktop.BeginExportFolder') return { id: 'final-folder', path: '/exports' }
        if (method === 'Desktop.BeginFolderExport')
          return { id: 'final', filename: 'final.bin', path: '/exports/final.bin' }
        if (method === 'Desktop.FinishExport') nativeLate.abort()
      }
    }
    const commitSink = await beginExportFolder('/exports'),
      nativeSaved = await commitSink.write(blob, 'final.bin', { signal: nativeLate.signal })
    await commitSink.close()
    delete window.mygo
    return {
      size,
      earlyError,
      middleError,
      progress,
      completeProgress,
      completed,
      entries,
      byteValues: [...new Set(completeBytes)],
      lateSaved,
      nativeFailure,
      nativeCalls: calls.map((call) => call[0]),
      beginError,
      beginCalls,
      nativeSaved,
      commitCalls
    }
  })
  assert.equal(result.earlyError, 'AbortError')
  assert.equal(result.middleError, 'AbortError')
  assert.deepEqual(result.progress, [
    { writtenBytes: 0, totalBytes: result.size },
    { writtenBytes: 524288, totalBytes: result.size }
  ])
  assert.deepEqual(
    result.completeProgress.map((item) => item.writtenBytes),
    [0, 524288, 1048576, result.size]
  )
  assert.deepEqual(result.entries, { 'middle.bin': 0, 'complete.bin': result.size })
  assert.deepEqual(result.byteValues, [73])
  assert.equal(result.completed.bytes, result.size)
  assert.equal(result.lateSaved.bytes, result.size)
  assert.deepEqual(result.nativeFailure, { name: 'AbortError', cleanup: 'Cleanup unavailable' })
  assert.deepEqual(result.nativeCalls, ['Desktop.WriteExport', 'Desktop.CancelExport'])
  assert.equal(result.beginError, 'AbortError')
  assert.deepEqual(result.beginCalls, [
    'Desktop.BeginExportFolder',
    'Desktop.BeginFolderExport',
    'Desktop.CancelExport',
    'Desktop.EndExportFolder'
  ])
  assert.equal(result.nativeSaved.bytes, result.size)
  assert.deepEqual(result.commitCalls, [
    'Desktop.BeginExportFolder',
    'Desktop.BeginFolderExport',
    'Desktop.WriteExport',
    'Desktop.WriteExport',
    'Desktop.WriteExport',
    'Desktop.FinishExport',
    'Desktop.EndExportFolder'
  ])
})
