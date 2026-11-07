import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makeVideoFixture } from './fixtures/video.mjs'
import { videoTrialOutcome } from '../scripts/native-video-trials.mjs'

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const bytes = [...(await makeVideoFixture(page))]
  const id = await page.evaluate(async (bytes) => {
    const imported = await window.openlr.run('import', {
      files: [new File([Uint8Array.from(bytes)], 'private-video.webm', { type: 'video/webm' })]
    })
    if (imported.failed.length) throw Error(imported.failed[0].error)
    globalThis.openlrNativePlatform = 'darwin'
    globalThis.openlrDiagnostics = false
    window.diagnosticCalls = 0
    globalThis.mygo = {
      call: () => {
        window.diagnosticCalls++
        return Promise.resolve()
      }
    }
    return imported.added[0]
  }, bytes)
  return { page, bytes, id }
}

test('exhausted initial loads retain real admission and both pre-cleanup snapshots through dispatch', async (t) => {
  const { page, bytes, id } = await workspace(t)
  const result = await page.evaluate(async (id) => {
    const prototype = HTMLMediaElement.prototype
    const src = Object.getOwnPropertyDescriptor(prototype, 'src')
    const players = []
    Object.defineProperty(prototype, 'src', {
      ...src,
      set(url) {
        players.push(this)
        this.addEventListener(
          'loadedmetadata',
          () => {
            Object.defineProperty(this, 'error', { value: { code: 3, message: 'Media failed to decode' } })
            this.dispatchEvent(new Event('error'))
          },
          { once: true }
        )
        src.set.call(this, url)
      }
    })
    try {
      const before = await window.openlr.run('state')
      const reply = JSON.parse(
        JSON.stringify(await window.openlr.dispatch('video-seek', { time: 0.35, photoId: id }))
      )
      const after = await window.openlr.run('state')
      const original = [
        ...new Uint8Array(
          await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer()
        )
      ]
      return {
        before,
        after,
        reply,
        original,
        released: players.map((video) => ({ removed: !video.hasAttribute('src'), ready: video.readyState })),
        calls: window.diagnosticCalls
      }
    } finally {
      Object.defineProperty(prototype, 'src', src)
    }
  }, id)
  assert.equal(result.reply.ok, false)
  assert.equal(result.reply.error.message, 'Media failed to decode')
  const failure = result.reply.error.details.video
  assert.equal(failure.phase, 'initial-load')
  assert.equal(failure.operation, 'initial-open')
  assert.equal(failure.origin, 'native-media')
  assert.equal(failure.errorName, 'Error')
  assert.equal(failure.errorConstructor, 'NativeMediaError')
  assert.equal(failure.mediaErrorCode, 3)
  assert.equal(failure.attempt, 2)
  assert.equal(failure.retriesUsed, 1)
  assert.equal(failure.retryLimit, 1)
  assert.equal(failure.failedLoads.length, 2)
  for (const [index, load] of failure.failedLoads.entries()) {
    assert.equal(load.attempt, index + 1)
    assert.equal(load.phase, 'initial-load')
    assert.equal(load.mediaErrorCode, 3)
    assert.ok(load.readyState >= 1)
    assert.deepEqual(load.metadata, {
      seen: true,
      trusted: true,
      admitted: true,
      width: 96,
      height: 64,
      readyState: load.metadata.readyState
    })
    assert.ok(load.metadata.readyState >= 1)
    assert.equal('failedLoads' in load, false)
  }
  assert.deepEqual(result.released, [
    { removed: true, ready: 0 },
    { removed: true, ready: 0 }
  ])
  assert.equal(result.after.mode, 'grid')
  assert.equal(result.after.playback, null)
  assert.deepEqual(result.after.photos, result.before.photos)
  assert.deepEqual(result.original, bytes)
  assert.equal(result.calls, 0)
  assert.equal(JSON.stringify(failure).includes('private-video'), false)
})

test('rejected metadata and finalization failures are recorded without broadening recovery', async (t) => {
  const { page } = await workspace(t)
  for (const kind of ['before-metadata', 'zero-dimensions', 'finalization']) {
    await t.test(kind, async () => {
      const result = await page.evaluate(async (kind) => {
        const prototype = HTMLMediaElement.prototype
        const src = Object.getOwnPropertyDescriptor(prototype, 'src')
        let count = 0
        Object.defineProperty(prototype, 'src', {
          ...src,
          set(url) {
            count++
            const fail = () => {
              Object.defineProperty(this, 'error', { value: { code: 3, message: 'Media failed to decode' } })
              this.dispatchEvent(new Event('error'))
            }
            if (kind === 'zero-dimensions') Object.defineProperty(this, 'videoWidth', { value: 0 })
            if (kind === 'finalization')
              this.addEventListener(
                'loadeddata',
                () => Object.defineProperty(this, 'duration', { value: 0 }),
                { once: true, capture: true }
              )
            else if (kind !== 'before-metadata') this.addEventListener('loadedmetadata', fail, { once: true })
            src.set.call(this, url)
            if (kind === 'before-metadata') fail()
          }
        })
        try {
          const reply = await window.openlr.dispatch('video-seek', { time: 0.35 })
          return { count, reply }
        } finally {
          Object.defineProperty(prototype, 'src', src)
        }
      }, kind)
      assert.equal(result.count, 1)
      assert.equal(result.reply.ok, false)
      const failure = result.reply.error.details.video
      assert.equal(failure.failedLoads.length, 1)
      assert.equal(failure.attempt, 1)
      assert.equal(failure.retriesUsed, 0)
      if (kind === 'finalization') {
        assert.equal(failure.phase, 'initial-finalize')
        assert.equal(failure.metadata.admitted, true)
        assert.equal(failure.mediaErrorCode, null)
        assert.equal(result.reply.error.message, 'No playable video track')
      } else {
        assert.equal(failure.phase, 'initial-load')
        assert.equal(failure.metadata.admitted, false)
        assert.equal(failure.metadata.seen, kind !== 'before-metadata')
        assert.equal(failure.metadata.trusted, kind === 'before-metadata' ? null : true)
        assert.equal(failure.metadata.width, kind === 'before-metadata' ? null : 0)
      }
    })
  }
})

test('native frame access and actual fallback frame reads with identical messages retain distinct origins', async (t) => {
  for (const fallback of [false, true]) {
    await t.test(fallback ? 'fallback decoder' : 'native pixels', async (t) => {
      const { page, bytes } = await workspace(t)
      if (fallback) {
        await page.route('**/video-frames-real.js', async (route) =>
          route.fulfill({
            contentType: 'text/javascript',
            body: await readFile(new URL('../web/video-frames.js', import.meta.url), 'utf8')
          })
        )
        await page.route('**/video-frames.js', (route) =>
          route.fulfill({
            contentType: 'text/javascript',
            body: `
          import { decodeVideoFrames as actual } from './video-frames-real.js'
          export async function decodeVideoFrames(file) {
            const source = await actual(file)
            return { ...source, async at(time) {
              const frame = await source.at(time)
              window.decodedFrameSize = [frame.width, frame.height]
              const error = new DOMException('Media failed to decode', 'EncodingError')
              error.details = { retained: 'existing details', video: { retainedField: 'existing video details' } }
              throw error
            }, close() { window.decoderClosed = true; source.close() } }
          }
        `
          })
        )
      }
      const result = await page.evaluate(async (fallback) => {
        const prototype = CanvasRenderingContext2D.prototype,
          drawImage = prototype.drawImage
        prototype.drawImage = function (source, ...args) {
          if (source instanceof HTMLVideoElement) {
            if (fallback) throw new DOMException('Controlled origin restriction', 'SecurityError')
            Object.defineProperty(source, 'error', { value: { code: 3, message: 'Media failed to decode' } })
            const error = Error('Media failed to decode')
            error.details = {
              retained: 'existing details',
              video: { retainedField: 'existing video details' }
            }
            throw error
          }
          return drawImage.call(this, source, ...args)
        }
        try {
          const reply = await window.openlr.dispatch('video-seek', { time: 0.35 })
          const state = await window.openlr.run('state')
          const original = [
            ...new Uint8Array(
              await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer()
            )
          ]
          return { reply, state, original, decoded: window.decodedFrameSize, closed: window.decoderClosed }
        } finally {
          prototype.drawImage = drawImage
        }
      }, fallback)
      assert.equal(result.reply.error.message, 'Media failed to decode')
      assert.equal(result.reply.error.details.retained, 'existing details')
      assert.equal(result.reply.error.details.video.retainedField, 'existing video details')
      const failure = result.reply.error.details.video
      assert.equal(failure.phase, fallback ? 'frame-read' : 'frame-access')
      assert.equal(failure.origin, fallback ? 'frame-decoder' : 'native-pixels')
      assert.equal(failure.operation, 'initial-frame')
      assert.equal(failure.mediaErrorCode, fallback ? null : 3)
      assert.equal(failure.errorName, fallback ? 'EncodingError' : 'Error')
      assert.equal(failure.errorConstructor, fallback ? 'DOMException' : 'Error')
      if (fallback) assert.equal(failure.domExceptionCode, 0)
      assert.equal(failure.metadata.admitted, true)
      assert.equal(failure.attempt, 1)
      assert.deepEqual(failure.failedLoads, [])
      assert.equal(result.state.mode, 'grid')
      assert.equal(result.state.playback, null)
      assert.deepEqual(result.original, bytes)
      if (fallback) {
        assert.deepEqual(result.decoded, [96, 64])
        assert.equal(result.closed, true)
      }
    })
  }
})

test('initial positioning and the requested seek are separated without retrying either', async (t) => {
  for (const initial of [true, false]) {
    await t.test(initial ? 'initial zero position' : 'requested 0.35 seek', async (t) => {
      const { page } = await workspace(t)
      const result = await page.evaluate(async (initial) => {
        const prototype = HTMLMediaElement.prototype
        const src = Object.getOwnPropertyDescriptor(prototype, 'src')
        const duration = Object.getOwnPropertyDescriptor(prototype, 'duration')
        const time = Object.getOwnPropertyDescriptor(prototype, 'currentTime')
        const players = []
        const error = (video) =>
          Object.defineProperty(video, 'error', { value: { code: 3, message: 'Media failed to decode' } })
        Object.defineProperty(prototype, 'src', {
          ...src,
          set(url) {
            players.push(this)
            if (initial)
              Object.defineProperty(this, 'duration', {
                get() {
                  const value = duration.get.call(this)
                  if (this.readyState >= 2 && !this.error) error(this)
                  return value
                }
              })
            src.set.call(this, url)
          }
        })
        if (!initial)
          Object.defineProperty(prototype, 'currentTime', {
            ...time,
            set(value) {
              time.set.call(this, value)
              if (value === 0.35) {
                error(this)
                this.dispatchEvent(new Event('error'))
              }
            }
          })
        try {
          const reply = await window.openlr.dispatch('video-seek', { time: 0.35 })
          const state = await window.openlr.run('state')
          return { reply, state, released: players.map((video) => !video.hasAttribute('src')) }
        } finally {
          Object.defineProperty(prototype, 'src', src)
          Object.defineProperty(prototype, 'currentTime', time)
        }
      }, initial)
      const failure = result.reply.error.details.video
      assert.equal(result.reply.error.message, 'Media failed to decode')
      assert.equal(failure.phase, 'seek')
      assert.equal(failure.operation, initial ? 'initial-position' : 'requested-seek')
      assert.equal(failure.origin, 'native-media')
      assert.equal(failure.mediaErrorCode, 3)
      assert.equal(failure.attempt, 1)
      assert.deepEqual(failure.failedLoads, [])
      assert.deepEqual(result.released, [true])
      assert.equal(result.state.mode, 'grid')
      assert.equal(result.state.playback, null)
    })
  }
})

test('a fallback frame failure after a completed requested seek is identified as draw-frame', async (t) => {
  const { page } = await workspace(t)
  await page.route('**/video-frames-real.js', async (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: await readFile(new URL('../web/video-frames.js', import.meta.url), 'utf8')
    })
  )
  await page.route('**/video-frames.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `
    import { decodeVideoFrames as actual } from './video-frames-real.js'
    export async function decodeVideoFrames(file) {
      const source = await actual(file)
      return { ...source, async at(time) { const frame = await source.at(time); if (Math.abs(time - 0.35) < 0.001) throw Error('Media failed to decode'); return frame } }
    }
  `
    })
  )
  const result = await page.evaluate(async () => {
    const prototype = CanvasRenderingContext2D.prototype,
      drawImage = prototype.drawImage
    prototype.drawImage = function (source, ...args) {
      if (source instanceof HTMLVideoElement)
        throw new DOMException('Controlled origin restriction', 'SecurityError')
      return drawImage.call(this, source, ...args)
    }
    try {
      const reply = await window.openlr.dispatch('video-seek', { time: 0.35 })
      const failed = await window.openlr.run('state')
      const retried = await window.openlr.run('video-seek', { time: 0.5 })
      await window.openlr.run('library')
      return { reply, failed, retried }
    } finally {
      prototype.drawImage = drawImage
    }
  })
  assert.equal(result.reply.error.message, 'Media failed to decode')
  assert.equal(result.failed.playback.time, 0.35)
  assert.equal(result.failed.mode, 'detail')
  assert.equal(result.reply.error.details.video.phase, 'frame-read')
  assert.equal(result.reply.error.details.video.operation, 'draw-frame')
  assert.equal(result.reply.error.details.video.origin, 'frame-decoder')
  assert.equal(result.reply.error.details.video.mediaErrorCode, null)
  assert.equal(result.retried.playback.time, 0.5)
})

test('trial reports retain a full whitelisted failure without changing success or cleanup gates', () => {
  const metadata = {
    seen: true,
    trusted: true,
    admitted: true,
    width: 96,
    height: 64,
    readyState: 1,
    url: 'private'
  }
  const failure = {
    phase: 'initial-load',
    origin: 'native-media',
    mediaErrorCode: 3,
    attempt: 2,
    retriesUsed: 1,
    retryLimit: 1,
    metadata,
    failedLoads: [
      { phase: 'initial-load', metadata },
      { phase: 'initial-load', metadata }
    ],
    path: 'private',
    bytes: [1, 2],
    stack: 'private'
  }
  const cleanup =
    JSON.stringify({ nativeVideoCleanup: 'confirmed' }) +
    '\n' +
    JSON.stringify({ nativeVideoOracleCleanup: 'confirmed' })
  const outcome = videoTrialOutcome(
    1,
    null,
    JSON.stringify({ nativeVideo: 'failed', failure }) + '\n' + cleanup
  )
  assert.equal(outcome.verified, false)
  assert.equal(outcome.continueTrials, true)
  assert.equal(outcome.failure.failedLoads.length, 2)
  assert.equal(outcome.failure.failedLoads[0].metadata.trusted, true)
  assert.equal(JSON.stringify(outcome.failure).includes('private'), false)
  assert.equal(
    videoTrialOutcome(1, null, JSON.stringify({ nativeVideo: 'failed', failure })).continueTrials,
    false
  )
})
