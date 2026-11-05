import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { readPng } from '../web/png.js'
import { makeColorProfile } from '../web/color-spaces.js'

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  return page
}

const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
async function importPhotos(page) {
  const files = await page.evaluate(async () => {
    const result = []
    for (const [name, width, height, color] of [
      ['first.png', 80, 60, '#537b91'],
      ['second.png', 120, 90, '#9a5c38']
    ]) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').fillStyle = color
      canvas.getContext('2d').fillRect(0, 0, width, height)
      result.push({
        name,
        mimeType: 'image/png',
        bytes: Array.from(
          new Uint8Array(await (await new Promise((resolve) => canvas.toBlob(resolve))).arrayBuffer())
        )
      })
    }
    return result
  })
  await page
    .locator('#files')
    .setInputFiles(
      files.map((file) => ({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.bytes) }))
    )
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)
  return {
    files,
    ids: Object.fromEntries((await run(page, 'state')).photos.map((photo) => [photo.name, photo.id]))
  }
}

async function chooseOptions(
  page,
  { format = 'image/png', colorSpace = 'display-p3', maxSize = 48, watermark = 'OpenLR' } = {}
) {
  await page.locator('#export').click()
  await page.locator('#format').selectOption(format)
  if (await page.locator('#export-color-space').isVisible())
    await page.locator('#export-color-space').selectOption(colorSpace)
  if (await page.locator('#export-size').isVisible()) await page.locator('#export-size').fill(String(maxSize))
  if (await page.locator('#watermark').isVisible()) await page.locator('#watermark').fill(watermark)
}

async function download(page, action) {
  const pending = page.waitForEvent('download')
  await action()
  const result = await pending
  return { filename: result.suggestedFilename(), bytes: await readFile(await result.path()) }
}

async function waitSettings(page, media, options) {
  // The pinned Playwright polls synchronous predicates; an async predicate's
  // Promise is truthy before its false result resolves, ending polling early.
  await page.waitForFunction(
    ({ media, options }) => {
      const saved = JSON.parse(localStorage.getItem('export-settings') || 'null')?.[media]
      return (
        saved &&
        Object.keys(saved).length === Object.keys(options).length &&
        Object.entries(options).every(([key, value]) => saved[key] === value)
      )
    },
    { media, options }
  )
}

function assertPng(bytes, width, height, space = 'display-p3') {
  const png = readPng(bytes)
  assert.deepEqual([png.width, png.height], [width, height])
  assert.deepEqual(png.metadata.icc, makeColorProfile(space))
  return png
}

test('GUI previous export saves real options, uses the current photo and edits, and survives browser restart', async (t) => {
  const server = await serveWorkspace(),
    directory = await mkdtemp(join(tmpdir(), 'openlr-export-previous-')),
    launchOptions = {
      channel: process.env.CHROME_CHANNEL || 'chrome',
      headless: true,
      acceptDownloads: true,
      viewport: { width: 1280, height: 900 }
    }
  t.after(server.close)
  let context = await chromium.launchPersistentContext(directory, launchOptions)
  t.after(async () => {
    await context.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 4 })
  })
  let page = context.pages()[0]
  await page.goto(server.url)
  const { ids, files } = await importPhotos(page),
    options = { format: 'image/png', colorSpace: 'display-p3', maxSize: 48, watermark: 'OpenLR' }
  assert.equal(await page.locator('#export-previous').isVisible(), true)
  await page.locator('#export-previous').click()
  await page.locator('#export-dialog[open]').waitFor()
  assert.equal(await page.locator('#format').inputValue(), 'image/jpeg')
  await page.locator('#export-dialog button[value=cancel]').click()
  await chooseOptions(page)
  const first = await download(page, () => page.locator('#export-dialog button[value=ok]').click())
  assert.equal(first.filename, 'first.png')
  assertPng(first.bytes, 48, 36)
  await waitSettings(page, 'photo', options)
  assert.equal((await run(page, 'export-settings')).video, null)
  await context.close()
  context = await chromium.launchPersistentContext(directory, launchOptions)
  page = context.pages()[0]
  await page.goto(server.url)
  await page.locator('#gallery .tile').first().waitFor()
  await page.locator('#export').click()
  assert.equal(await page.locator('#format').inputValue(), 'image/png')
  assert.equal(await page.locator('#export-color-space').inputValue(), 'display-p3')
  assert.equal(await page.locator('#export-size').inputValue(), '48')
  assert.equal(await page.locator('#watermark').inputValue(), 'OpenLR')
  await page.locator('#export-dialog button[value=cancel]').click()
  await run(page, 'select', { id: ids['second.png'] })
  await run(page, 'edit', { key: 'Exposure', value: 0.5 })
  await run(page, 'edit', { key: 'turn', value: 1 })
  const edit = (await run(page, 'state')).photos.find((photo) => photo.id === ids['second.png']).edit
  await page.evaluate(() => document.activeElement?.blur())
  const repeated = await download(page, () => page.keyboard.press('Control+e'))
  assert.equal(repeated.filename, 'second.png')
  assertPng(repeated.bytes, 36, 48)
  const ordinary = await page.evaluate(
    async (options) =>
      Array.from(new Uint8Array(await (await window.openlr.run('export', options)).blob.arrayBuffer())),
    options
  )
  assert.deepEqual(repeated.bytes, Buffer.from(ordinary))
  const clicked = await download(page, () => page.locator('#export-previous').click())
  assert.deepEqual(clicked.bytes, repeated.bytes)
  const agent = await page.evaluate(() => window.openlr.dispatch('export-previous'))
  assert.equal(agent.ok, true)
  assert.deepEqual(Buffer.from(agent.result.base64, 'base64'), repeated.bytes)
  assert.deepEqual(agent.result.exportSettings, { media: 'photo', options })
  const ordinaryAgent = await page.evaluate((options) => window.openlr.dispatch('export', options), options)
  assert.equal(ordinaryAgent.ok, true)
  assert.deepEqual(Buffer.from(ordinaryAgent.result.base64, 'base64'), repeated.bytes)
  assert.deepEqual(ordinaryAgent.result.exportSettings, { media: 'photo', options })
  const preview = await page.evaluate(() => window.openlr.dispatch('preview', { maxSize: 12 }))
  assert.equal(preview.ok, true)
  assert.equal(preview.result.kind, 'file')
  assert.equal(preview.result.mimeType, 'image/png')
  assert.equal(Object.hasOwn(preview.result, 'exportSettings'), false)
  assert.deepEqual(
    (await run(page, 'state')).photos.find((photo) => photo.id === ids['second.png']).edit,
    edit
  )
  const original = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
    )
  )
  assert.deepEqual(original, files[1].bytes)
  assert.deepEqual(
    (await run(page, 'export-settings')).photo,
    options,
    'Generating original bytes without acknowledging a save must not change settings'
  )
})

test('real GUI rendering remembers only completed native-boundary saves and distinguishes write from settings failure', async (t) => {
  const page = await workspace(t)
  await importPhotos(page)
  const initial = { format: 'image/png', colorSpace: 'srgb', maxSize: 40 }
  await run(page, 'export-settings', { media: 'photo', options: initial })
  // Inject only after startup: real rendering and GUI events run normally. This
  // is an adapter simulation, not a native file-dialog acceptance claim.
  await page.evaluate(() => {
    window.exportBoundary = { mode: '', calls: [], chunks: [], started: 0, completed: 0 }
    const dialog = document.getElementById('export-dialog'),
      originalClose = dialog.onclose
    dialog.onclose = async function (event) {
      const attempt = ++window.exportBoundary.started,
        mode = window.exportBoundary.mode
      try {
        await originalClose.call(this, event)
      } finally {
        window.exportBoundary.completedMode = mode
        window.exportBoundary.completed = attempt
      }
    }
    const originalSet = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'export-settings' && window.exportBoundary.mode === 'remember-failure')
        throw Error('Remember storage denied')
      return originalSet.call(this, key, value)
    }
    window.mygo = {
      call: async (method, ...args) => {
        const test = window.exportBoundary
        test.calls.push([method, ...args])
        if (method === 'Desktop.BeginExport') {
          if (test.mode === 'cancel') return ''
          if (test.mode === 'begin-failure') throw Error('Begin save failed')
          return 'generated-transfer'
        }
        if (method === 'Desktop.WriteExport') {
          if (test.mode === 'write-failure') throw Error('Write save failed')
          test.chunks.push(args[1])
          return
        }
        if (method === 'Desktop.FinishExport') {
          if (test.mode === 'finish-failure') throw Error('Finish save failed')
          return
        }
        if (method === 'Desktop.CancelExport') return
        throw Error('Unexpected native boundary ' + method)
      }
    }
  })
  for (const [index, mode] of [
    'cancel',
    'begin-failure',
    'write-failure',
    'finish-failure',
    'success',
    'remember-failure'
  ].entries()) {
    const before = await run(page, 'export-settings'),
      maxSize = 31 + index,
      expected = { format: 'image/png', colorSpace: 'display-p3', maxSize, watermark: mode }
    const attempt = await page.evaluate((mode) => {
      const boundary = window.exportBoundary
      if (boundary.started !== boundary.completed) throw Error('Previous export handler is still running')
      Object.assign(boundary, { mode, calls: [], chunks: [] })
      return boundary.started + 1
    }, mode)
    await chooseOptions(page, { maxSize, watermark: mode })
    await page.locator('#export-dialog button[value=ok]').click()
    // The real async handler includes save completion, acknowledgment and its
    // error notice. Await all of it before inspecting or reconfiguring the mock.
    await page.waitForFunction((attempt) => window.exportBoundary.completed === attempt, attempt)
    const boundary = await page.evaluate(() => window.exportBoundary),
      methods = boundary.calls.map((call) => call[0])
    assert.equal(boundary.completedMode, mode)
    const context = `${mode}: native calls for completed attempt ${attempt}`
    if (mode === 'cancel' || mode === 'begin-failure')
      assert.deepEqual(methods, ['Desktop.BeginExport'], context)
    else if (mode === 'write-failure')
      assert.deepEqual(
        methods,
        ['Desktop.BeginExport', 'Desktop.WriteExport', 'Desktop.CancelExport'],
        context
      )
    else if (mode === 'finish-failure')
      assert.deepEqual(
        methods,
        ['Desktop.BeginExport', 'Desktop.WriteExport', 'Desktop.FinishExport', 'Desktop.CancelExport'],
        context
      )
    else {
      assert.deepEqual(
        methods,
        ['Desktop.BeginExport', 'Desktop.WriteExport', 'Desktop.FinishExport'],
        context
      )
      const bytes = Buffer.concat(boundary.chunks.map((chunk) => Buffer.from(chunk, 'base64')))
      assertPng(bytes, maxSize, Math.round((maxSize * 60) / 80))
    }
    if (mode.includes('failure')) {
      const message =
        mode === 'remember-failure'
          ? 'Export saved, but settings could not be remembered: Remember storage denied'
          : mode.split('-')[0][0].toUpperCase() + mode.split('-')[0].slice(1) + ' save failed'
      assert.equal(await page.locator('#notice').textContent(), message, mode)
    }
    assert.deepEqual(
      await run(page, 'export-settings'),
      mode === 'success' ? { ...before, photo: expected } : before
    )
  }
})

test('malformed saved settings cannot trigger a default export and legacy valid settings migrate after a successful GUI save', async (t) => {
  const page = await workspace(t)
  await importPhotos(page)
  for (const invalid of [
    '{',
    'null',
    '[]',
    '"png"',
    '{}',
    '{"photo":{"format":"video/webm"}}',
    '{"photo":{"format":"image/png","maxSize":0}}'
  ]) {
    await page.evaluate((value) => localStorage.setItem('export-settings', value), invalid)
    const response = await page.evaluate(() => window.openlr.dispatch('export-previous'))
    assert.equal(response.ok, false)
    assert.match(response.error.message, /Choose export settings first/)
    await page.locator('#export-previous').click()
    await page.locator('#export-dialog[open]').waitFor()
    assert.equal(await page.locator('#format').inputValue(), 'image/jpeg')
    await page.locator('#export-dialog button[value=cancel]').click()
    assert.equal(await page.evaluate(() => localStorage.getItem('export-settings')), invalid)
  }
  const legacy = { format: 'image/png', quality: 0.7, colorSpace: 'display-p3', maxSize: 22 }
  await page.evaluate((value) => {
    localStorage.removeItem('export-settings')
    localStorage.setItem('last-export', JSON.stringify(value))
  }, legacy)
  assert.deepEqual((await run(page, 'export-settings')).photo, {
    format: 'image/png',
    colorSpace: 'display-p3',
    maxSize: 22
  })
  assert.equal(await page.evaluate(() => localStorage.getItem('export-settings')), null)
  const saved = await download(page, () => page.locator('#export-previous').click())
  assertPng(saved.bytes, 22, 17)
  await waitSettings(page, 'photo', { format: 'image/png', colorSpace: 'display-p3', maxSize: 22 })
  assert.notEqual(await page.evaluate(() => localStorage.getItem('export-settings')), null)
  assert.deepEqual((await run(page, 'export-settings')).video, {
    format: 'image/png',
    colorSpace: 'display-p3',
    maxSize: 22
  })
  await page.evaluate(() => {
    const originalGet = Storage.prototype.getItem
    Storage.prototype.getItem = function (key) {
      if (key === 'export-settings') throw Error('Read storage denied')
      return originalGet.call(this, key)
    }
  })
  await page.locator('#export-previous').click()
  await page.waitForFunction(() => document.getElementById('notice').textContent === 'Read storage denied')
  assert.equal(await page.locator('#export-dialog').isVisible(), false)
})

test('real video and photo settings stay independent and a video may reuse a raster export', async (t) => {
  const page = await workspace(t)
  const { ids } = await importPhotos(page)
  await chooseOptions(page, { maxSize: 32, watermark: 'Photo' })
  await download(page, () => page.locator('#export-dialog button[value=ok]').click())
  const photoOptions = { format: 'image/png', colorSpace: 'display-p3', maxSize: 32, watermark: 'Photo' }
  await waitSettings(page, 'photo', photoOptions)
  const videoId = await page.evaluate(async () => {
    const m = await import('./vendor/mediabunny/mediabunny.mjs'),
      canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 24
    const target = new m.BufferTarget(),
      output = new m.Output({ target, format: new m.WebMOutputFormat() }),
      source = new m.CanvasSource(canvas, { codec: 'vp9', bitrate: 100000 })
    output.addVideoTrack(source)
    await output.start()
    for (let i = 0; i < 2; i++) {
      canvas.getContext('2d').fillStyle = i ? '#174ad0' : '#ad3417'
      canvas.getContext('2d').fillRect(0, 0, 32, 24)
      await source.add(i * 0.2, 0.2)
    }
    await output.finalize()
    const result = await window.openlr.run('import', {
      files: [new File([target.buffer], 'clip.webm', { type: 'video/webm' })]
    })
    if (result.failed.length) throw Error(result.failed[0].error)
    return result.added[0]
  })
  await page.locator('#export').click()
  assert.equal(await page.locator('#format').inputValue(), 'video/mp4')
  await page.locator('#format').selectOption('video/webm')
  await page.locator('#export-size').fill('24')
  const first = await download(page, () => page.locator('#export-dialog button[value=ok]').click())
  assert.equal(first.filename, 'clip.webm')
  assert.deepEqual(Array.from(first.bytes.subarray(0, 4)), [0x1a, 0x45, 0xdf, 0xa3])
  await waitSettings(page, 'video', { format: 'video/webm', maxSize: 24 })
  await run(page, 'select', { id: ids['first.png'] })
  const still = await download(page, () => page.locator('#export-previous').click())
  assertPng(still.bytes, 32, 24)
  await run(page, 'select', { id: videoId })
  const repeated = await download(page, () => page.locator('#export-previous').click())
  const dimensions = await page.evaluate(async (bytes) => {
    const m = await import('./vendor/mediabunny/mediabunny.mjs'),
      input = new m.Input({
        source: new m.BlobSource(new Blob([Uint8Array.from(bytes)], { type: 'video/webm' })),
        formats: m.ALL_FORMATS
      })
    try {
      const track = await input.getPrimaryVideoTrack()
      return [await track.getDisplayWidth(), await track.getDisplayHeight(), await input.computeDuration()]
    } finally {
      input.dispose()
    }
  }, Array.from(repeated.bytes))
  assert.deepEqual(dimensions.slice(0, 2), [24, 18])
  assert.ok(Math.abs(dimensions[2] - 0.4) < 0.055)
  await chooseOptions(page, { maxSize: 15, watermark: 'Frame' })
  const frame = await download(page, () => page.locator('#export-dialog button[value=ok]').click())
  assert.equal(frame.filename, 'clip.png')
  assertPng(frame.bytes, 15, 11)
  const videoRaster = { format: 'image/png', colorSpace: 'display-p3', maxSize: 15, watermark: 'Frame' }
  await waitSettings(page, 'video', videoRaster)
  assert.deepEqual((await run(page, 'export-settings')).photo, photoOptions)
  const again = await download(page, () => page.locator('#export-previous').click())
  assert.deepEqual(again.bytes, frame.bytes)
})
