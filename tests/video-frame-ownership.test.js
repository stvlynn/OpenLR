import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'
import { makeVideoFixture } from './fixtures/video.mjs'
import { readPng } from '../web/png.js'

const stillRgb = [15, 24, 103]
const trim = { start: 1.2, end: 2.7 }
const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
const color = (image) => {
  const offset = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4
  return Array.from(image.data.subarray(offset, offset + 4), (value) => Math.round(value * 255))
}
const isBlue = ([r, g, b]) => b > 2 * Math.max(r, g)
const isGreen = ([r, g, b]) => g > 2 * Math.max(r, b)

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const video = await makeVideoFixture(page)
  await page.evaluate(async () => {
    const marked = new WeakSet(),
      draw = CanvasRenderingContext2D.prototype.drawImage,
      read = CanvasRenderingContext2D.prototype.getImageData
    let failures = 0,
      video
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (...args) {
      if (this instanceof HTMLVideoElement) video = this
      return play.apply(this, args)
    }
    // Reproduce only the observed native origin-clean rejection. Leave the
    // real media clock, demuxer, video decoder, canvas and PNG pipeline intact.
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      if (source instanceof HTMLVideoElement && this.canvas.width === 1 && this.canvas.height === 1)
        marked.add(this)
      return draw.call(this, source, ...args)
    }
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      if (marked.has(this)) {
        failures++
        throw new DOMException('Controlled video origin-clean failure', 'SecurityError')
      }
      return read.apply(this, args)
    }
    const { CanvasSink } = await import('/vendor/mediabunny/mediabunny.mjs')
    const canvases = CanvasSink.prototype.canvases,
      getCanvas = CanvasSink.prototype.getCanvas,
      createBitmap = window.createImageBitmap
    let held, heldStill, heldSparse
    function deferred() {
      let release
      const pending = new Promise((resolve) => {
        release = resolve
      })
      return { pending, release }
    }
    window.createImageBitmap = async (source, ...args) => {
      const gate = source instanceof File && source.name === 'still.png' ? heldStill : null
      const bitmap = await createBitmap(source, ...args)
      if (gate) {
        gate.entered = true
        await gate.pending
      }
      return bitmap
    }
    CanvasSink.prototype.getCanvas = async function (time, ...args) {
      const gate = heldSparse?.time === undefined ? heldSparse : null
      if (gate) gate.time = time
      const frame = await getCanvas.call(this, time, ...args)
      if (gate) {
        gate.decoded = true
        await gate.pending
      }
      return frame
    }
    const stageColor = () => {
      const canvas = document.querySelector('#stage canvas')
      if (!canvas) return null
      return Array.from(
        canvas
          .getContext('2d')
          .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
      )
    }
    let publications = []
    const stage = document.querySelector('#stage')
    new MutationObserver(() => {
      const color = stageColor()
      if (color) publications.push(color)
    }).observe(stage, { childList: true })
    CanvasSink.prototype.canvases = async function* (...args) {
      const gate = held?.started ? null : held
      if (gate) gate.started = true
      try {
        for await (const frame of canvases.apply(this, args)) {
          if (gate && gate.timestamp === undefined) {
            gate.timestamp = frame.timestamp
            await gate.pending
            gate.released = true
          }
          yield frame
        }
      } finally {
        if (gate) gate.closed = true
      }
    }
    window.videoOwnership = {
      arm() {
        held = deferred()
      },
      armStill() {
        heldStill = deferred()
      },
      armSparse() {
        heldSparse = deferred()
      },
      get stillPending() {
        return heldStill?.entered
      },
      get sparseTime() {
        return heldSparse?.decoded ? heldSparse.time : undefined
      },
      get clock() {
        return video?.currentTime
      },
      get videoPaused() {
        return video?.paused
      },
      get entered() {
        return held?.timestamp
      },
      get released() {
        return held?.released
      },
      get closed() {
        return held?.closed
      },
      get failures() {
        return failures
      },
      release() {
        held.release()
      },
      releaseStill() {
        heldStill.release()
        heldStill = null
      },
      releaseSparse() {
        heldSparse.release()
        heldSparse = null
      },
      resetPublications() {
        publications = []
      },
      read() {
        return { stage: stageColor(), publications }
      }
    }
  })
  const png = makePng({
    width: 32,
    height: 24,
    bits: 8,
    data: Array(32 * 24)
      .fill(stillRgb)
      .flat()
  })
  await page.locator('#files').setInputFiles([
    { name: 'clip.webm', mimeType: 'video/webm', buffer: video },
    { name: 'still.png', mimeType: 'image/png', buffer: Buffer.from(png) }
  ])
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2, null, {
    timeout: 10000
  })
  const { photos } = await run(page, 'state')
  const clip = photos.find(({ name }) => name === 'clip.webm').id,
    still = photos.find(({ name }) => name === 'still.png').id
  assert.ok(await page.evaluate(() => window.videoOwnership.failures > 0))
  await run(page, 'select', { id: clip })
  await run(page, 'view', { mode: 'detail' })
  return { page, video, clip, still }
}

async function holdPlayback(page) {
  await run(page, 'video-seek', { time: 0.35 })
  await page.evaluate(() => window.videoOwnership.arm())
  await page.locator('#play-video').click()
  await page.waitForFunction(() => window.videoOwnership.entered !== undefined, null, { timeout: 5000 })
  const time = await page.evaluate(() => window.videoOwnership.entered)
  assert.ok(time < 1, `Expected a held frame in the red segment, got ${time}`)
}

async function releasePlayback(page, close = true) {
  await page.evaluate(() => {
    window.videoOwnership.resetPublications()
    window.videoOwnership.release()
  })
  await page.waitForFunction(
    (closed) => window.videoOwnership.released && (!closed || window.videoOwnership.closed),
    close,
    { timeout: 5000 }
  )
  return page.evaluate(async () => {
    // Let the resumed consumer and subsequent repaint callbacks run.
    for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame)
    return window.videoOwnership.read()
  })
}

test(
  'held decoded playback frames cannot publish after pause, seek, asset switch or a newer recipe',
  { timeout: 60000 },
  async (t) => {
    const { page, clip, still } = await workspace(t)
    await holdPlayback(page)
    const paused = (await run(page, 'video-pause')).playback
    assert.equal(paused.playing, false)
    assert.deepEqual((await releasePlayback(page)).publications, [])
    assert.deepEqual((await run(page, 'state')).playback, paused)

    await holdPlayback(page)
    const sought = (await run(page, 'video-seek', { time: 2.35 })).playback
    assert.deepEqual({ time: sought.time, playing: sought.playing }, { time: 2.35, playing: false })
    const afterSeek = await releasePlayback(page)
    assert.ok(isBlue(afterSeek.stage), JSON.stringify(afterSeek))
    assert.deepEqual(afterSeek.publications, [])
    assert.deepEqual((await run(page, 'state')).playback, sought)

    await holdPlayback(page)
    await page.evaluate(() => window.videoOwnership.armStill())
    const switching = run(page, 'select', { id: still })
    // Keep the real new decode pending while the old decoded video resumes.
    void switching.catch(() => {})
    try {
      await page.waitForFunction(() => window.videoOwnership.stillPending, null, { timeout: 5000 })
      assert.equal(await page.evaluate(() => window.videoOwnership.videoPaused), true)
      assert.deepEqual((await releasePlayback(page)).publications, [])
    } finally {
      await page.evaluate(() => window.videoOwnership.releaseStill())
      await switching
    }
    const afterSelect = await page.evaluate(() => window.videoOwnership.read())
    assert.deepEqual(afterSelect.stage, [...stillRgb, 255])
    assert.deepEqual(afterSelect.publications, [[...stillRgb, 255]])
    const selected = await run(page, 'state')
    assert.equal(selected.selected, still)
    assert.equal(selected.playback, null)

    await run(page, 'select', { id: clip })
    await holdPlayback(page)
    await run(page, 'edit', { key: 'Exposure', value: -4 })
    await releasePlayback(page, false)
    await page.waitForFunction(() => window.videoOwnership.read().publications.length > 0, null, {
      timeout: 5000
    })
    const afterEdit = await page.evaluate(() => window.videoOwnership.read())
    const dark = (pixel) => Math.max(...pixel.slice(0, 3)) < 100
    assert.ok(dark(afterEdit.stage), JSON.stringify(afterEdit))
    assert.ok(afterEdit.publications.every(dark), JSON.stringify(afterEdit))
    const edited = await run(page, 'video-pause')
    assert.equal(edited.photos.find(({ id }) => id === clip).edit.Exposure, -4)
    assert.equal(edited.playback.playing, false)
  }
)

async function pngResult(page, command, args = {}) {
  const bytes = await page.evaluate(
    async ([c, a]) => {
      const { blob } = await window.openlr.run(c, a)
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    },
    [command, args]
  )
  return readPng(Uint8Array.from(bytes))
}

test(
  'decoded-frame fallback keeps single and saved stills on the playhead and batch output at trim start',
  { timeout: 60000 },
  async (t) => {
    const { page, video, clip, still } = await workspace(t)
    await run(page, 'video-trim', trim)
    await run(page, 'edit', { key: 'turn', value: 1 })
    await run(page, 'video-seek', { time: 2.35 })
    // This simulated destination alone is substituted. The dispatcher opens an
    // independent source, decodes at trim start, renders, and streams its PNG.
    const output = await page.evaluate(
      async ([clip, still]) => {
        const files = new Map()
        window.showDirectoryPicker = async () => ({
          async *keys() {
            yield* files.keys()
          },
          async getFileHandle(name) {
            return {
              async createWritable() {
                const chunks = []
                return {
                  async write(chunk) {
                    chunks.push(chunk)
                  },
                  async close() {
                    files.set(name, new Blob(chunks))
                  }
                }
              }
            }
          }
        })
        const run = window.openlr.run
        await run('select-many', { ids: [clip, still] })
        const before = await run('state')
        if (before.selected !== clip) throw Error('Expected the video to remain active')
        const result = await run('export-selection', { format: 'image/png' })
        const after = await run('state')
        const exported = result.files.find(({ id }) => id === clip)
        return {
          before,
          after,
          count: result.files.length,
          bytes: Array.from(new Uint8Array(await files.get(exported.filename).arrayBuffer()))
        }
      },
      [clip, still]
    )
    assert.equal(output.count, 2)
    for (const key of ['selected', 'selection', 'photos', 'playback'])
      assert.deepEqual(output.after[key], output.before[key])
    const batch = readPng(Uint8Array.from(output.bytes))
    const single = await pngResult(page, 'export', { format: 'image/png' })
    const preview = await pngResult(page, 'preview')
    for (const image of [batch, single, preview]) assert.deepEqual([image.width, image.height], [64, 96])
    assert.ok(isGreen(color(batch)), JSON.stringify(color(batch)))
    assert.ok(isBlue(color(single)), JSON.stringify(color(single)))
    assert.deepEqual(preview.data, single.data)
    const saved = await run(page, 'save-frame')
    const state = await run(page, 'state')
    assert.equal(state.selected, saved.added[0])
    assert.equal(state.photos.find(({ id }) => id === state.selected).name, 'clip-2350.png')
    const savedImage = await pngResult(page, 'export', { format: 'original' })
    assert.deepEqual([savedImage.width, savedImage.height], [64, 96])
    assert.deepEqual(savedImage.data, single.data)
    await run(page, 'select', { id: clip })
    await run(page, 'video-seek', { time: 1.25 })
    await page.locator('#play-video').click()
    await page.waitForFunction(() => window.videoOwnership.clock >= 1.4, null, { timeout: 5000 })
    await page.evaluate(() => window.videoOwnership.armSparse())
    const pendingSave = run(page, 'save-frame')
    void pendingSave.catch(() => {})
    let time
    try {
      await page.waitForFunction(() => window.videoOwnership.sparseTime !== undefined, null, {
        timeout: 5000
      })
      time = await page.evaluate(() => window.videoOwnership.sparseTime)
      assert.ok(time >= 1.4 && time < 2)
      await page.waitForFunction(() => window.videoOwnership.clock >= 2.15, null, { timeout: 5000 })
    } finally {
      await page.evaluate(() => window.videoOwnership.releaseSparse())
    }
    const inFlight = await pendingSave
    const afterSave = await run(page, 'state')
    assert.equal(afterSave.selected, inFlight.added[0])
    assert.equal(
      afterSave.photos.find(({ id }) => id === afterSave.selected).name,
      `clip-${Math.round(time * 1000)}.png`
    )
    assert.ok(isGreen(color(await pngResult(page, 'export', { format: 'original' }))))
    await run(page, 'select', { id: clip })
    const original = await page.evaluate(async () => {
      const { blob } = await window.openlr.run('export', { format: 'original' })
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    })
    assert.deepEqual(Buffer.from(original), video)
  }
)
