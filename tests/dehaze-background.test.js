import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  return page
}
test('prepared dehaze coalesces consumers, isolates cancellation and revisions, and retries failed handoff', async (t) => {
  const page = await workspace(t)
  const result = await page.evaluate(async () => {
    const { prepareDehaze, renderFramePrepared, renderFrame, renderPrepared, render } =
      await import('./render.js')
    const NativeWorker = window.Worker
    let count = 0,
      fail = false
    const urls = []
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (url.pathname?.endsWith('dehaze-worker.js')) {
          count++
          const code = fail
            ? `self.onmessage=()=>self.postMessage({code:'FIXTURE',message:'Injected analysis failure'});self.postMessage({ready:true})`
            : `setTimeout(()=>import(${JSON.stringify(url.href)}),80)`
          fail = false
          const blob = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
          urls.push(blob)
          super(blob, options)
        } else super(url, options)
      }
    }
    const source = () => ({
      width: 96,
      height: 64,
      colorSpace: 'srgb-linear',
      data: Float32Array.from({ length: 96 * 64 * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0.15 + (i % 37) / 50))
    })
    const image = source(),
      before = image.data.slice(),
      controller = new AbortController()
    const draft = prepareDehaze(image, { Dehaze: 30 }, { signal: controller.signal }).catch((e) => e.name)
    const command = prepareDehaze(image, { Dehaze: 70 })
    controller.abort()
    const draftResult = await draft,
      ready = await command,
      sharedCount = count
    const output = await renderFramePrepared(image, { Dehaze: 70 }, 48)
    const reference = renderFrame({ ...image, data: image.data.slice() }, { Dehaze: 70 }, 48)
    const equal = output.data.every((v, i) => v === reference.data[i])
    const sourceUnchanged = image.data.every((v, i) => v === before[i])
    const revisionSource = source(),
      revisedEdit = { Dehaze: 25, optics: { manualDistortion: 20 } }
    const oldRevision = renderFramePrepared(revisionSource, { Dehaze: 25 }, 32)
    const newRevision = renderFramePrepared(revisionSource, revisedEdit, 32)
    await oldRevision
    const revised = await newRevision,
      jobsAfterRevision = count
    const revisedAgain = await renderFramePrepared(revisionSource, revisedEdit, 32)
    const revisedExpected = renderFrame(
      { ...revisionSource, data: revisionSource.data.slice() },
      revisedEdit,
      32
    )
    const revisionExact =
      revised.data.every((v, i) => v === revisedExpected.data[i] && v === revisedAgain.data[i]) &&
      count === jobsAfterRevision

    const negativeImage = source(),
      negative = await prepareDehaze(negativeImage, { Dehaze: -30 })
    const retained = negative.source.data.slice()
    await prepareDehaze(negativeImage, { Dehaze: 30 })
    const upgradePreserved =
      negative.source.data.length === retained.length &&
      negative.source.data.every((v, i) => v === retained[i])
    const abortImage = source(),
      ab = new AbortController()
    const canceled = prepareDehaze(abortImage, { Dehaze: 30 }, { signal: ab.signal }).catch((e) => e.name)
    ab.abort()
    const abortResult = await canceled
    await new Promise((resolve) => setTimeout(resolve, 0))
    const retry = await prepareDehaze(abortImage, { Dehaze: 30 })
    const broken = source()
    fail = true
    const failure = await prepareDehaze(broken, { Dehaze: 30 }).catch((e) => e.code)
    const repaired = await prepareDehaze(broken, { Dehaze: 30 })
    const canvas = document.createElement('canvas')
    canvas.width = 16
    canvas.height = 12
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#506070'
    ctx.fillRect(0, 0, 16, 12)
    const first = await renderPrepared(canvas, { Dehaze: -40 })
    ctx.fillStyle = '#a08060'
    ctx.fillRect(0, 0, 16, 12)
    const second = await renderPrepared(canvas, { Dehaze: -40 }),
      expected = render(canvas, { Dehaze: -40 })
    const bytes = (c) => c.getContext('2d').getImageData(0, 0, 16, 12).data
    const mutableChanged = bytes(first).some((v, i) => v !== bytes(second)[i])
    const mutableExact = bytes(second).every((v, i) => v === bytes(expected)[i])
    const { preparePhotoExport } = await import('./photo-export.js')
    const { bindWorkingFrame } = await import('./working-frames.js')
    const exportController = new AbortController(),
      exportFrame = source()
    const surface = document.createElement('canvas')
    surface.width = 96
    surface.height = 64
    bindWorkingFrame(surface, exportFrame)
    const countBeforeExport = count
    const exported = preparePhotoExport(
      { id: 'generated', name: 'generated.png', edit: { processVersion: 2, Dehaze: 30 } },
      { format: 'image/png' },
      {
        original: async () => {
          throw Error('Unexpected original read')
        },
        source: async () => surface,
        signal: exportController.signal
      }
    ).then(
      () => false,
      (error) => error === exportController.signal.reason
    )
    while (count === countBeforeExport) await new Promise((resolve) => setTimeout(resolve, 2))
    exportController.abort()
    const exportCanceled = await exported
    window.Worker = NativeWorker
    urls.forEach(URL.revokeObjectURL)
    return {
      draftResult,
      sharedCount,
      equal,
      sourceUnchanged,
      upgradePreserved,
      abortResult,
      retried: !!retry.analysis.transmission,
      failure,
      repaired: !!repaired.analysis.transmission,
      originalAttached: broken.data.byteLength,
      mutableChanged,
      mutableExact,
      revisionExact,
      exportCanceled,
      readySamples: ready.source.data.length
    }
  })
  assert.equal(result.draftResult, 'AbortError')
  assert.equal(result.sharedCount, 1)
  for (const key of [
    'equal',
    'sourceUnchanged',
    'upgradePreserved',
    'retried',
    'repaired',
    'mutableChanged',
    'mutableExact',
    'revisionExact',
    'exportCanceled'
  ])
    assert.equal(result[key], true, key)
  assert.equal(result.abortResult, 'AbortError')
  assert.equal(result.failure, 'FIXTURE')
  assert.equal(result.originalAttached, 96 * 64 * 16)
  assert.equal(result.readySamples, 96 * 64 * 4)
})

test('live dehaze drafts share analysis with commit and cannot paint over another photo', async (t) => {
  const page = await workspace(t)
  await page.evaluate(() => {
    const NativeWorker = window.Worker
    window.dehazeJobs = 0
    window.dehazeTerminations = 0
    window.heartbeat = 0
    setInterval(() => window.heartbeat++, 10)
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (url.pathname?.endsWith('dehaze-worker.js')) {
          window.dehazeJobs++
          const blob = URL.createObjectURL(
            new Blob([`setTimeout(()=>import(${JSON.stringify(url.href)}),200)`], { type: 'text/javascript' })
          )
          super(blob, options)
          this.dehaze = true
        } else super(url, options)
      }
      terminate() {
        if (this.dehaze) window.dehazeTerminations++
        super.terminate()
      }
    }
  })
  const width = 96,
    height = 64
  const pixels = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixels.set(y < 8 ? [255, 255, 255] : [120 + (x % 41), 140 + (y % 31), 170], (y * width + x) * 3)
  const buffer = Buffer.from(makePng({ width, height, bits: 8, colorType: 2, srgb: 0, data: pixels }))
  await page.locator('#files').setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer },
    { name: 'second.png', mimeType: 'image/png', buffer }
  ])
  const run = (command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
  await waitForAsyncFunction(page, async () => (await window.openlr.run('state')).photos.length === 2)
  const state = await run('state'),
    first = state.photos[0].id,
    second = state.photos[1].id
  await run('select', { id: first })
  await run('view', { mode: 'detail' })
  await run('processing', { version: 2 })
  await run('panel', { name: 'Effects', open: true })
  const draft = (value) =>
    page.locator('[data-control="Dehaze"]').evaluate((input, value) => {
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, String(value))
  const beforeTicks = await page.evaluate(() => window.heartbeat)
  await draft(40)
  await page.waitForFunction(() => window.dehazeJobs === 1)
  await draft(70)
  await page
    .locator('[data-control="Dehaze"]')
    .evaluate((input) => input.dispatchEvent(new Event('change', { bubbles: true })))
  await waitForAsyncFunction(page, async () => {
    const s = await window.openlr.run('state')
    return s.photos.find((p) => p.id === s.selected).edit.Dehaze === 70
  })
  assert.equal(await page.evaluate(() => window.dehazeJobs), 1)
  assert.ok((await page.evaluate(() => window.heartbeat)) - beforeTicks >= 5)
  await run('undo')
  assert.equal((await run('state')).photos.find((p) => p.id === first).edit.Dehaze, undefined)
  await run('redo')
  await run('select', { id: second })
  await run('view', { mode: 'detail' })
  await draft(35)
  await page.waitForFunction(() => window.dehazeJobs === 2)
  await run('select', { id: first })
  const stage = () =>
    page
      .locator('#stage canvas')
      .first()
      .evaluate((c) => c.toDataURL())
  const expected = await stage()
  await page.waitForTimeout(350)
  assert.equal(await stage(), expected)
  const after = await run('state')
  assert.equal(after.selected, first)
  assert.equal(after.photos.find((p) => p.id === second).edit.Dehaze, undefined)
  assert.equal(after.photos.find((p) => p.id === first).edit.Dehaze, 70)
  // Re-selecting the first photo decodes a fresh source; the old disposable
  // bitmap is intentionally not retained across selection.
  assert.equal(await page.evaluate(() => window.dehazeJobs), 3)
})

test('leaving a Local folder aborts pending thumbnail analysis without publishing stale dimensions or pixels', async (t) => {
  const page = await workspace(t)
  const data = new Uint8Array(32 * 24 * 3).fill(140)
  const png = Buffer.from(makePng({ width: 32, height: 24, bits: 8, colorType: 2, srgb: 0, data }))
  await page.route('http://localphoto.localhost/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: png
    })
  )
  const result = await page.evaluate(async () => {
    const local = await import('./local.js'),
      root = { id: 'generated', name: 'Generated local fixture' }
    window.mygo = {
      platform: 'win32',
      call: async (method) => {
        if (method === 'Local.Folders') return [root]
        if (method === 'Local.OpenFolder')
          return {
            root,
            relative: '.',
            directories: [],
            photos: [
              {
                name: 'generated.png',
                relative: 'generated.png',
                size: 100,
                modified: 1,
                recipe: { edit: { Dehaze: 40 } }
              }
            ]
          }
        throw Error('Unexpected fixture call ' + method)
      }
    }
    window.IntersectionObserver = undefined
    const NativeWorker = window.Worker
    let jobs = 0,
      terminated = 0,
      callbacks = 0
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (url.pathname?.endsWith('dehaze-worker.js')) {
          jobs++
          super(
            URL.createObjectURL(
              new Blob([`setTimeout(()=>import(${JSON.stringify(url.href)}),150)`], {
                type: 'text/javascript'
              })
            ),
            options
          )
          this.dehaze = true
        } else super(url, options)
      }
      terminate() {
        if (this.dehaze) terminated++
        super.terminate()
      }
    }
    const wait = async (fn) => {
      const start = performance.now()
      while (!fn()) {
        if (performance.now() - start > 5000) throw Error('Local test phase timed out')
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    const first = (await local.open(root.id)).photos[0],
      placeholder = first.thumbnail
    const img = document.createElement('img')
    img.width = 100
    img.height = 100
    document.body.append(img)
    local.observeThumbnail(first, img, () => callbacks++)
    await wait(() => jobs === 1)
    local.leave()
    await wait(() => terminated === 1)
    const second = (await local.open(root.id)).photos[0]
    local.observeThumbnail(second, img, () => callbacks++)
    await wait(() => callbacks === 1)
    const result = {
      callbacks,
      staleUnchanged: first.thumbnail === placeholder,
      width: first.width,
      height: first.height,
      newWidth: second.width,
      newHeight: second.height,
      newType: second.thumbnail.type,
      jobs
    }
    local.leave()
    img.remove()
    window.Worker = NativeWorker
    return result
  })
  assert.equal(result.callbacks, 1)
  assert.equal(result.staleUnchanged, true)
  assert.equal(result.width, 0)
  assert.equal(result.height, 0)
  assert.equal(result.newWidth, 32)
  assert.equal(result.newHeight, 24)
  assert.equal(result.newType, 'image/jpeg')
  assert.equal(result.jobs, 2)
})
