import { waitForAsyncFunction } from './browser-wait.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import UTIF from '../web/vendor/codecs/utif.js'
import { serveWorkspace } from './browser-server.mjs'
import { makeDng } from './fixtures/dng.mjs'

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  return {
    page,
    run: (command, args = {}) =>
      page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args])
  }
}

// A neutral two-by-two Bayer ramp generated from OpenLR's original fixture.
// The 12-bit sensor contains more distinct levels than an 8-bit display can show.
function sensorRamp() {
  const width = 256,
    height = 64,
    bytes = makeDng({ width, height }),
    view = new DataView(bytes.buffer)
  let offset
  for (let n = 0; n < view.getUint16(8, true); n++) {
    const at = 10 + n * 12
    if (view.getUint16(at, true) === 273) offset = view.getUint32(at + 8, true)
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      view.setUint16(
        offset + 2 * (y * width + x),
        256 + 120 + Math.floor(x / 2) * 22 + Math.floor(y / 2),
        true
      )
  return Buffer.from(bytes)
}

async function pixels(page, command = 'preview') {
  return page.evaluate(async (command) => {
    const { blob } = await window.openlr.run(command, command === 'export' ? { format: 'image/png' } : {})
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
  }, command)
}

async function exportedBytes(page, format, options = {}) {
  return Uint8Array.from(
    await page.evaluate(
      async ([format, options]) => {
        const { blob } = await window.openlr.run('export', { format, ...options })
        return Array.from(new Uint8Array(await blob.arrayBuffer()))
      },
      [format, options]
    )
  )
}

function tiffSamples(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ifd = UTIF.decode(buffer)[0]
  UTIF.decodeImage(buffer, ifd)
  const view = new DataView(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength)
  return {
    ifd,
    samples: Uint16Array.from({ length: view.byteLength / 2 }, (_, index) => view.getUint16(index * 2, true))
  }
}

test('GUI opt-in uses actual wide RAW samples, recovers local exposure, exports low TIFF bits, and switches back to identical legacy pixels', async (t) => {
  const { page, run } = await workspace(t),
    raw = sensorRamp()
  await page
    .locator('#files')
    .setInputFiles({ name: 'linear-ramp.dng', mimeType: 'image/x-adobe-dng', buffer: raw })
  await page.locator('#gallery .tile').waitFor()
  await run('view', { mode: 'detail' })
  assert.deepEqual((await run('state')).photos[0].edit, {})
  const legacy = await pixels(page)
  await page.locator('#processing-version').selectOption('2')
  await waitForAsyncFunction(
    page,
    async () => (await window.openlr.run('state')).photos[0].edit.processVersion === 2
  )
  const neutral = await pixels(page),
    baselineTiff = tiffSamples(await exportedBytes(page, 'image/tiff'))
  assert.deepEqual(baselineTiff.ifd.t258, [16, 16, 16, 16])
  assert.ok(baselineTiff.ifd.t34675.length > 100)
  let lowBits = 0
  const byteGroups = new Map()
  let hiddenDifference = false
  for (let i = 0; i < baselineTiff.samples.length; i += 4) {
    const value = baselineTiff.samples[i],
      byte = Math.round(value / 257)
    if (value > 0 && value < 65535 && value % 257 !== 0) lowBits++
    if (byteGroups.has(byte) && byteGroups.get(byte) !== value) hiddenDifference = true
    byteGroups.set(byte, value)
  }
  assert.ok(lowBits > 100, 'RAW export must retain low bits beyond replicated display bytes')
  assert.ok(hiddenDifference, 'Distinct exported sensor levels must survive within one display byte')
  const marked = tiffSamples(await exportedBytes(page, 'image/tiff', { watermark: 'OpenLR' }))
  assert.deepEqual(marked.ifd.t258, [16, 16, 16, 16])
  assert.notDeepEqual(marked.samples, baselineTiff.samples, 'The watermark must affect the exported pixels')
  assert.deepEqual(
    marked.samples.subarray(0, neutral.width * Math.floor(neutral.height / 2) * 4),
    baselineTiff.samples.subarray(0, neutral.width * Math.floor(neutral.height / 2) * 4),
    'Pixels away from the watermark must keep every source bit rather than traverse an RGBA8 canvas'
  )
  assert.deepEqual(await pixels(page), neutral, 'Watermark composition must not mutate the decoded source')
  await run('mask.add', {
    mask: {
      type: 'semantic',
      raster: { width: 1, height: 1, encoding: 'base64-u8', data: '/w==' },
      adjustments: { Exposure: 4 }
    }
  })
  await run('edit', { key: 'Exposure', value: -4 })
  const recovered = await pixels(page)
  assert.deepEqual(
    recovered,
    neutral,
    '+4 EV locally followed by -4 EV globally must recover the decoded RAW view'
  )
  assert.deepEqual(tiffSamples(await exportedBytes(page, 'image/tiff')).samples, baselineTiff.samples)
  assert.deepEqual(await pixels(page, 'export'), neutral)
  await run('compare')
  assert.deepEqual(await pixels(page), neutral, 'Original comparison must keep the linear decode')
  await run('compare')
  await run('processing', { version: 1 })
  const clipped = await pixels(page)
  assert.notDeepEqual(
    clipped.data,
    neutral.data,
    'The legacy intermediate should expose this clipping stress case'
  )
  await run('reset')
  assert.deepEqual(
    await pixels(page),
    legacy,
    'Switching the cache back to original processing must reproduce its bytes'
  )
  await run('processing', { version: 2 })
  assert.deepEqual(await pixels(page), neutral)
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  await run('view', { mode: 'detail' })
  assert.equal((await run('state')).photos[0].edit.processVersion, 2)
  assert.deepEqual(
    await pixels(page),
    neutral,
    'Reload must recreate the linear source rather than reuse the legacy thumbnail'
  )
  assert.deepEqual(Buffer.from(await exportedBytes(page, 'original')), raw)
})

test('processing upgrades, undo, reset, snapshots, presets and XMP preserve the active recipe version', async (t) => {
  const { page, run } = await workspace(t)
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 48
    canvas.height = 32
    const paint = canvas.getContext('2d')
    paint.fillStyle = '#7898ab'
    paint.fillRect(0, 0, 48, 32)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve))
    await window.openlr.run('import', { files: [new File([blob], 'lifecycle.png', { type: 'image/png' })] })
  })
  await run('view', { mode: 'detail' })
  await run('edit', { key: 'Exposure', value: 0.5 })
  const legacyPreset = await run('preset-save', { name: 'Legacy half stop' }),
    legacyVersion = await run('version-save', { name: 'Legacy' })
  assert.deepEqual(legacyPreset.edit, { Exposure: 0.5 })
  await run('processing', { version: 2 })
  assert.deepEqual((await run('state')).photos[0].edit, { processVersion: 2, Exposure: 0.5 })
  await run('undo')
  assert.deepEqual((await run('state')).photos[0].edit, { Exposure: 0.5 })
  await run('redo')
  const currentVersion = await run('version-save', { name: 'Linear' }),
    currentPreset = await run('preset-save', { name: 'Linear half stop' })
  const xml = new TextDecoder().decode(await exportedBytes(page, 'application/rdf+xml'))
  assert.equal(currentPreset.edit.processVersion, 2)
  await run('reset')
  assert.deepEqual((await run('state')).photos[0].edit, { processVersion: 2 })
  await run('filter', { edited: 'no' })
  assert.equal((await run('state')).photos.length, 1)
  await run('filter', { edited: 'any' })
  await run('preset-apply', { id: legacyPreset.id })
  assert.deepEqual((await run('state')).photos[0].edit, { processVersion: 1, Exposure: 0.5 })
  await run('preset-apply', { id: currentPreset.id })
  assert.deepEqual((await run('state')).photos[0].edit, { processVersion: 2, Exposure: 0.5 })
  await run('version-restore', { id: legacyVersion.id })
  assert.deepEqual((await run('state')).photos[0].edit, { Exposure: 0.5 })
  await run('version-restore', { id: currentVersion.id })
  assert.deepEqual((await run('state')).photos[0].edit, { processVersion: 2, Exposure: 0.5 })
  await run('processing', { version: 1 })
  await run('apply-xmp', { xml })
  const before = (await run('state')).photos[0].edit
  assert.deepEqual(before, { processVersion: 2, Exposure: 0.5 })
  for (const args of [{ version: 3 }, { version: '2' }, { version: 2, photoId: 'different-photo' }]) {
    const failure = await page.evaluate((args) => window.openlr.dispatch('processing', args), args)
    assert.equal(failure.ok, false)
    assert.deepEqual((await run('state')).photos[0].edit, before)
  }
  const failure = await page.evaluate(
    (xml) => window.openlr.dispatch('apply-xmp', { xml }),
    xml.replace('&quot;processVersion&quot;:2', '&quot;processVersion&quot;:3')
  )
  assert.equal(failure.ok, false)
  assert.deepEqual((await run('state')).photos[0].edit, before)
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  assert.deepEqual((await run('state')).photos[0].edit, before)
  assert.ok(
    (await run('state')).photos[0].versions.some(
      (version) => version.id === currentVersion.id && version.edit.processVersion === 2
    )
  )
  await run('preset-apply', { id: currentPreset.id })
  assert.equal((await run('state')).photos[0].edit.processVersion, 2)
})

test('live slider frames wait for a matching committed recipe during both processing-version switches', async (t) => {
  const { page, run } = await workspace(t),
    errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 48
    canvas.height = 32
    const paint = canvas.getContext('2d'),
      gradient = paint.createLinearGradient(0, 0, 48, 0)
    gradient.addColorStop(0, '#21435f')
    gradient.addColorStop(1, '#a2b8cc')
    paint.fillStyle = gradient
    paint.fillRect(0, 0, 48, 32)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve))
    await window.openlr.run('import', { files: [new File([blob], 'slider-race.png', { type: 'image/png' })] })
  })
  await run('view', { mode: 'detail' })
  await run('processing', { version: 2 })
  for (const [from, to] of [
    [2, 1],
    [1, 2]
  ]) {
    await run('edit', { key: 'Exposure', value: 0 })
    assert.equal((await run('state')).photos[0].edit.processVersion, from)
    const before = await pixels(page)
    await page.evaluate((to) => {
      const original = HTMLCanvasElement.prototype.toBlob
      window.sliderRace = {
        original,
        canvas: document.querySelector('#stage canvas'),
        stage: document.querySelector('#stage canvas').toDataURL(),
        pending: null,
        completed: false,
        failure: null
      }
      let holdNext = true
      HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
        if (!holdNext) return original.call(this, callback, ...args)
        holdNext = false
        return original.call(
          this,
          (blob) => {
            window.sliderRace.pending = () => callback(blob)
          },
          ...args
        )
      }
      // The real thumbnail encoder runs, but its callback cannot commit the
      // recipe yet. source() has already installed the other-version bitmap.
      window.openlr.run('processing', { version: to }).then(
        () => {
          window.sliderRace.completed = true
        },
        (error) => {
          window.sliderRace.failure = error.message
          window.sliderRace.completed = true
        }
      )
    }, to)
    await page.waitForFunction(() => Boolean(window.sliderRace.pending))
    const held = await page.evaluate(async () => {
      const input = document.querySelector('input[data-control="Exposure"]')
      input.value = '1'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return {
        sameCanvas: document.querySelector('#stage canvas') === window.sliderRace.canvas,
        samePixels: document.querySelector('#stage canvas').toDataURL() === window.sliderRace.stage,
        completed: window.sliderRace.completed,
        failure: window.sliderRace.failure
      }
    })
    assert.deepEqual(
      held,
      { sameCanvas: true, samePixels: true, completed: false, failure: null },
      `${from} to ${to}: a slider RAF must not paint a mismatched source`
    )
    assert.deepEqual(errors, [])
    await page.evaluate(() => {
      // Queue the ordinary control commit while processing is still held.
      document
        .querySelector('input[data-control="Exposure"]')
        .dispatchEvent(new Event('change', { bubbles: true }))
      HTMLCanvasElement.prototype.toBlob = window.sliderRace.original
      window.sliderRace.pending()
    })
    await page.waitForFunction(() => window.sliderRace.completed)
    const state = await run('state')
    assert.deepEqual(state.photos[0].edit, { processVersion: to, Exposure: 1 })
    assert.equal(await page.evaluate(() => window.sliderRace.failure), null)
    const committed = await pixels(page),
      stage = await page.evaluate(() => {
        const canvas = document.querySelector('#stage canvas')
        return {
          width: canvas.width,
          height: canvas.height,
          data: Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)
        }
      })
    assert.notDeepEqual(
      committed.data,
      before.data,
      'The queued edit must eventually change the rendered image'
    )
    assert.deepEqual(
      stage,
      committed,
      `${from} to ${to}: the committed control and preview must render the same recipe`
    )
    assert.deepEqual(errors, [])
  }
})

test('video remains on original processing and rejects linear activation without changing its recipe', async (t) => {
  const { page, run } = await workspace(t)
  await page.evaluate(async () => {
    const m = await import('./vendor/mediabunny/mediabunny.mjs'),
      canvas = document.createElement('canvas')
    canvas.width = 48
    canvas.height = 32
    canvas.getContext('2d').fillRect(0, 0, 48, 32)
    const target = new m.BufferTarget(),
      output = new m.Output({ target, format: new m.WebMOutputFormat() }),
      source = new m.CanvasSource(canvas, { codec: 'vp9', bitrate: 100000 })
    output.addVideoTrack(source)
    await output.start()
    await source.add(0, 0.2)
    await source.add(0.2, 0.2)
    await output.finalize()
    await window.openlr.run('import', {
      files: [new File([target.buffer], 'process-video.webm', { type: 'video/webm' })]
    })
  })
  await run('view', { mode: 'detail' })
  assert.equal(await page.locator('#processing-version').isDisabled(), true)
  const before = (await run('state')).photos[0].edit
  const failure = await page.evaluate(() => window.openlr.dispatch('processing', { version: 2 }))
  assert.equal(failure.ok, false)
  assert.match(failure.error.message, /still photos/i)
  assert.deepEqual((await run('state')).photos[0].edit, before)
  assert.equal(await page.locator('#processing-version').inputValue(), '1')
})
