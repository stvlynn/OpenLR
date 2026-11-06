import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makeVideoFixture } from './fixtures/video.mjs'
import { readPng } from '../web/png.js'

const start = 0.85
const end = 1.2
const run = (page, command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])

async function fixture(t, { deferRollback = false } = {}) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const bytes = Array.from(await makeVideoFixture(page))
  const imported = await page.evaluate(
    async ({ bytes, start, end, deferRollback }) => {
      const marked = new WeakSet(),
        draw = CanvasRenderingContext2D.prototype.drawImage,
        read = CanvasRenderingContext2D.prototype.getImageData,
        pause = HTMLMediaElement.prototype.pause,
        clock = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
      const trace = []
      let pending,
        gate,
        concurrentSeek,
        delayedPause,
        lastRewound,
        resets = 0,
        sparseReads = 0
      CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
        if (source instanceof HTMLVideoElement && this.canvas.width === 1 && this.canvas.height === 1)
          marked.add(this)
        return draw.call(this, source, ...args)
      }
      CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        if (marked.has(this)) throw new DOMException('Controlled origin failure', 'SecurityError')
        return read.apply(this, args)
      }
      HTMLMediaElement.prototype.pause = function () {
        trace.push({ pause: this.currentTime, paused: this.paused })
        if (!this.paused && this.currentTime > 1.02) pending = this
        return pause.call(this)
      }
      const { CanvasSink } = await import('/vendor/mediabunny/mediabunny.mjs')
      const getCanvas = CanvasSink.prototype.getCanvas
      CanvasSink.prototype.getCanvas = async function (time, ...args) {
        sparseReads++
        const media = pending
        trace.push({ decode: time, resetsClock: Boolean(media) })
        pending = null
        const frame = await getCanvas.call(this, time, ...args)
        if (media) {
          if (deferRollback) {
            delayedPause = { media, writes: [] }
            return frame
          }
          await new Promise((resolve) => {
            media.addEventListener('seeked', resolve, { once: true })
            media.currentTime = start
          })
          resets++
          lastRewound = media
          if (gate) {
            const held = gate
            held.entered = true
            await held.wait
          }
        }
        return frame
      }
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
        ...clock,
        set(time) {
          if (delayedPause?.media === this) delayedPause.writes.push({ time, before: this.currentTime })
          if (concurrentSeek?.media === this && time === concurrentSeek.time)
            concurrentSeek.supersededWhileSeeking = this.seeking
          clock.set.call(this, time)
          if (concurrentSeek && !concurrentSeek.media && resets > 0 && time >= end) {
            concurrentSeek.media = this
            concurrentSeek.repairStarted = this.seeking
            queueMicrotask(() => {
              concurrentSeek.result = window.openlr.run('video-seek', { time: concurrentSeek.time })
            })
          }
        }
      })
      globalThis.pauseClock = {
        trace: () => trace,
        resets: () => resets,
        sparseReads: () => sparseReads,
        lateWrites: () => delayedPause.writes,
        async releaseDelayedRollback() {
          const { media, writes } = delayedPause
          // The native regression returns to the last seek position, even
          // though the ordinary paused read previously reported progress.
          await new Promise((resolve) => {
            media.addEventListener('seeked', resolve, { once: true })
            clock.set.call(media, writes.at(-1)?.time ?? start)
          })
          return media.currentTime
        },
        restoredAt(count, time) {
          return (
            resets >= count && lastRewound.paused && !lastRewound.seeking && lastRewound.currentTime >= time
          )
        },
        seekDuringRepair(time) {
          concurrentSeek = { time }
        },
        concurrentSeek: () => concurrentSeek,
        hold() {
          let release
          const wait = new Promise((resolve) => (release = resolve))
          gate = { wait, release }
        },
        waiting: () => Boolean(gate?.entered),
        release() {
          gate.release()
          gate = null
        }
      }
      const file = new File([Uint8Array.from(bytes)], 'pause-clock.webm', { type: 'video/webm' })
      return window.openlr.run('import', { files: [file] })
    },
    { bytes, start, end, deferRollback }
  )
  assert.deepEqual(imported.failed, [])
  return page
}

async function play(page) {
  await page.locator('#play-video').click()
  return playbackWhen(page, (playback) => playback.playing)
}

async function playbackWhen(page, predicate) {
  const deadline = Date.now() + 5000
  let playback
  do {
    ;({ playback } = await run(page, 'state'))
    if (predicate(playback)) return playback
    await delay(20)
  } while (Date.now() < deadline)
  assert.fail(`Playback did not reach the expected state ${JSON.stringify(playback)}`)
}

async function artifactColor(page, command, args = {}) {
  const bytes = await page.evaluate(
    async ([command, args]) => {
      const { blob } = await window.openlr.run(command, args)
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    },
    [command, args]
  )
  const { data, width, height } = readPng(Buffer.from(bytes))
  const index = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
  return Array.from(data.subarray(index, index + 3))
}

async function visibleColor(page) {
  return page
    .locator('#stage canvas')
    .evaluate((canvas) =>
      Array.from(canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data)
    )
}

test('paused video restores the captured playhead after a decoded read rewinds native time', async (t) => {
  const page = await fixture(t)
  await run(page, 'video-seek', { time: start })
  await play(page)
  await playbackWhen(page, ({ time }) => time >= 1.12)
  const sparseBefore = await page.evaluate(() => pauseClock.sparseReads())
  const { playback } = await run(page, 'video-pause')
  assert.equal(playback.playing, false)
  assert.ok(
    playback.time >= 1.12,
    JSON.stringify({ playback, trace: await page.evaluate(() => pauseClock.trace()) })
  )
  assert.equal(await page.evaluate(() => pauseClock.resets()), 1)
  assert.equal(await page.evaluate(() => pauseClock.sparseReads()), sparseBefore + 1)
  const [red, green, blue] = await artifactColor(page, 'preview')
  assert.ok(green > Math.max(red, blue) * 2)

  await run(page, 'video-trim', { start, end })
  await play(page)
  // Native pause happens before the decoded frame triggers the injected rewind.
  await page.waitForFunction(({ end }) => pauseClock.restoredAt(2, end), { end })
  const stopped = (await run(page, 'state')).playback
  assert.equal(stopped.playing, false)
  assert.ok(stopped.time >= end, JSON.stringify(stopped))
  assert.equal(await page.evaluate(() => pauseClock.resets()), 2)
  const sought = await run(page, 'video-seek', { time: 2.35 })
  assert.deepEqual(
    { time: sought.playback.time, playing: sought.playback.playing },
    { time: 2.35, playing: false }
  )
  const saved = await run(page, 'save-frame')
  assert.deepEqual(saved.failed, [])
  const still = (await run(page, 'state')).photos.find(({ id }) => id === saved.added[0])
  assert.equal(still.name, 'pause-clock-2350.png')
  const [savedRed, savedGreen, savedBlue] = await artifactColor(page, 'export', { format: 'original' })
  assert.ok(savedBlue > Math.max(savedRed, savedGreen) * 2)
})

test('a later explicit seek supersedes an automatic paused-frame repair', async (t) => {
  const page = await fixture(t)
  await run(page, 'video-trim', { start, end })
  await page.evaluate(() => pauseClock.hold())
  await play(page)
  await page.waitForFunction(() => pauseClock.waiting())
  const sought = await run(page, 'video-seek', { time: 0.2 })
  assert.equal(sought.playback.time, 0.2)
  await page.evaluate(async () => {
    pauseClock.release()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  assert.equal((await run(page, 'state')).playback.time, 0.2)
  const [red, green, blue] = await visibleColor(page)
  assert.ok(red > Math.max(green, blue) * 2)
})

test('a later explicit seek supersedes a native corrective seek already in flight', async (t) => {
  const page = await fixture(t)
  await run(page, 'video-trim', { start, end })
  await page.evaluate(() => pauseClock.seekDuringRepair(0.2))
  await play(page)
  await page.waitForFunction(() => Boolean(pauseClock.concurrentSeek()?.result))
  const result = await page.evaluate(async () => {
    const seek = pauseClock.concurrentSeek()
    const { playback } = await seek.result
    return {
      repairStarted: seek.repairStarted,
      supersededWhileSeeking: seek.supersededWhileSeeking,
      playback
    }
  })
  assert.equal(result.repairStarted, true)
  assert.equal(result.supersededWhileSeeking, true)
  assert.equal(result.playback.time, 0.2)
  assert.equal(result.playback.playing, false)
  assert.equal((await run(page, 'state')).playback.time, 0.2)
  const [red, green, blue] = await visibleColor(page)
  assert.ok(red > Math.max(green, blue) * 2)
})

test('pause seeks before a deferred native rollback can return to the earlier playhead', async (t) => {
  const page = await fixture(t, { deferRollback: true })
  await run(page, 'video-seek', { time: start })
  await play(page)
  const advanced = await playbackWhen(page, ({ time }) => time >= 1.12)
  const { playback } = await run(page, 'video-pause')
  assert.equal(playback.playing, false)
  assert.ok(playback.time >= advanced.time)
  const writes = await page.evaluate(() => pauseClock.lateWrites())
  const afterRollback = await page.evaluate(() => pauseClock.releaseDelayedRollback())
  assert.equal(afterRollback, playback.time, JSON.stringify({ playback, writes }))
  assert.equal(writes.length, 1)
  assert.equal(writes[0].time, playback.time)
  assert.ok(writes[0].before >= advanced.time)
  assert.equal((await run(page, 'video-seek', { time: playback.time })).playback.time, playback.time)
  assert.deepEqual(await page.evaluate(() => pauseClock.lateWrites()), writes)
  const [red, green, blue] = await artifactColor(page, 'preview')
  assert.ok(green > Math.max(red, blue) * 2)
})
