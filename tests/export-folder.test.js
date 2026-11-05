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
