import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makeVideoFixture } from './fixtures/video.mjs'

test('video media waits release their listeners and settle on close', { timeout: 30000 }, async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.route(server.url + '/', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Video media lifecycle</title>' })
  )
  await page.goto(server.url)
  const bytes = Array.from(await makeVideoFixture(page))

  await t.test('the macOS poster waits for presentation and releases its callback', async () => {
    const result = await page.evaluate(async (bytes) => {
      const { openVideo, poster } = await import('/video.js')
      const file = new File([Uint8Array.from(bytes)], 'poster.webm', { type: 'video/webm' })
      const prototype = HTMLVideoElement.prototype
      const { requestVideoFrameCallback, cancelVideoFrameCallback } = prototype
      const registrations = [],
        cancellations = []
      let present, loaded
      prototype.requestVideoFrameCallback = function (callback) {
        const handle = registrations.length
        registrations.push(this.hasAttribute('src'))
        present = callback
        loaded = new Promise((resolve) => this.addEventListener('loadeddata', resolve, { once: true }))
        return handle
      }
      prototype.cancelVideoFrameCallback = (handle) => cancellations.push(handle)
      globalThis.openlrNativePlatform = 'darwin'
      try {
        const media = await openVideo(file)
        media.close()
        let settled = false
        const pending = poster(file).then((result) => {
          settled = true
          return result
        })
        const trusted = (await loaded).isTrusted
        await new Promise((resolve) => setTimeout(resolve, 0))
        const settledBeforePresentation = settled
        present()

        function pixel({ bitmap }) {
          const canvas = new OffscreenCanvas(1, 1)
          const context = canvas.getContext('2d')
          context.drawImage(bitmap, 0, 0, 1, 1)
          bitmap.close()
          return Array.from(context.getImageData(0, 0, 1, 1).data)
        }
        const afterPresentation = pixel(await pending)
        const afterTimeout = pixel(await poster(file))
        const rejected = await poster(new File(['invalid'], 'invalid.webm', { type: 'video/webm' })).then(
          () => false,
          () => true
        )
        return {
          registrations,
          cancellations,
          trusted,
          settledBeforePresentation,
          afterPresentation,
          afterTimeout,
          rejected
        }
      } finally {
        delete globalThis.openlrNativePlatform
        prototype.requestVideoFrameCallback = requestVideoFrameCallback
        prototype.cancelVideoFrameCallback = cancelVideoFrameCallback
      }
    }, bytes)
    assert.deepEqual(result.registrations, [false, false, false])
    assert.deepEqual(result.cancellations, [0, 1, 2])
    assert.equal(result.trusted, true)
    assert.equal(result.settledBeforePresentation, false)
    assert.equal(result.rejected, true)
    for (const [red, green, blue, alpha] of [result.afterPresentation, result.afterTimeout]) {
      assert.ok(red > 130 && green < 100 && blue < 100 && alpha === 255)
    }
  })

  await t.test('closing an in-flight native seek rejects the pending operation', async () => {
    const result = await page.evaluate(async (bytes) => {
      const { openVideo } = await import('/video.js')
      const file = new File([Uint8Array.from(bytes)], 'lifecycle.webm', { type: 'video/webm' })
      const media = await openVideo(file)
      const { video } = media
      let outcome = 'pending'
      void media.seek(0.35).then(
        () => {
          outcome = 'resolved'
        },
        (error) => {
          outcome = error.name
        }
      )
      const seeking = video.seeking
      const emptied = new Promise((resolve) => {
        video.addEventListener('emptied', (event) => resolve(event.isTrusted), { once: true })
      })
      media.close()
      const trusted = await emptied
      return { seeking, trusted, outcome }
    }, bytes)
    assert.equal(result.seeking, true)
    assert.equal(result.trusted, true)
    assert.equal(result.outcome, 'AbortError')
  })

  await t.test('play and seek report a native decode error without waiting for another event', async () => {
    const result = await page.evaluate(async (bytes) => {
      const { openVideo } = await import('/video.js')
      const media = await openVideo(
        new File([Uint8Array.from(bytes)], 'lifecycle.webm', { type: 'video/webm' })
      )
      const { video } = media
      const failure = { code: 3, message: 'Controlled native decode failure' }
      let error = failure
      let playCalls = 0
      Object.defineProperty(video, 'error', { get: () => error })
      video.play = () => {
        playCalls++
        return new Promise(() => {})
      }
      async function outcome(operation) {
        let timer
        try {
          return await Promise.race([
            operation.then(
              () => 'resolved',
              (failure) => failure.message
            ),
            new Promise((resolve) => (timer = setTimeout(() => resolve('pending'), 1000)))
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      try {
        const preexisting = await Promise.all([
          outcome(media.play()),
          outcome(media.seek(0.35)),
          outcome(media.seek(video.currentTime))
        ])
        const callsBeforeError = playCalls
        error = null
        const pending = media.play()
        error = failure
        video.dispatchEvent(new Event('error'))
        return {
          preexisting,
          callsBeforeError,
          duringPlay: await outcome(pending),
          playCalls,
          expected: failure.message
        }
      } finally {
        media.close()
      }
    }, bytes)
    assert.deepEqual(result.preexisting, Array(3).fill(result.expected))
    assert.equal(result.callsBeforeError, 0)
    assert.equal(result.duringPlay, result.expected)
    assert.equal(result.playCalls, 1)
  })

  for (const property of ['src', 'currentTime']) {
    await t.test(`removes pending media listeners when the ${property} setter throws`, async () => {
      const result = await page.evaluate(
        async ({ bytes, property }) => {
          const { openVideo } = await import('/video.js')
          const file = new File([Uint8Array.from(bytes)], 'lifecycle.webm', { type: 'video/webm' })
          const media = property === 'currentTime' ? await openVideo(file) : null
          const target = media?.video ?? HTMLMediaElement.prototype
          const setter = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, property)
          const { addEventListener, removeEventListener } = EventTarget.prototype
          const expected = Error('Controlled media setter failure')
          const listeners = []
          EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (this instanceof HTMLVideoElement && (!media || this === media.video))
              listeners.push({ target: this, type, listener, signal: options?.signal })
            return addEventListener.call(this, type, listener, options)
          }
          EventTarget.prototype.removeEventListener = function (type, listener, options) {
            const entry = listeners.find(
              (entry) => entry.target === this && entry.type === type && entry.listener === listener
            )
            if (entry) entry.removed = true
            return removeEventListener.call(this, type, listener, options)
          }
          Object.defineProperty(target, property, {
            ...setter,
            set() {
              throw expected
            }
          })
          try {
            const sameError = await (media ? media.seek(0.35) : openVideo(file)).then(
              () => false,
              (error) => error === expected
            )
            return {
              sameError,
              registered: listeners.map(({ type }) => type),
              remaining: listeners
                .filter(({ removed, signal }) => !removed && !signal?.aborted)
                .map(({ type }) => type)
            }
          } finally {
            EventTarget.prototype.addEventListener = addEventListener
            EventTarget.prototype.removeEventListener = removeEventListener
            if (media) {
              delete target[property]
              media.close()
            } else Object.defineProperty(target, property, setter)
          }
        },
        { bytes, property }
      )
      assert.equal(result.sameError, true)
      assert.ok(result.registered.includes(property === 'src' ? 'loadeddata' : 'seeked'))
      assert.ok(result.registered.includes('error'))
      assert.deepEqual(result.remaining, [])
    })
  }
})
