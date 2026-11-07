import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makeVideoFixture } from './fixtures/video.mjs'

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  return { page, bytes: Array.from(await makeVideoFixture(page)) }
}

async function interceptLoads(page, options = {}) {
  await page.evaluate(
    ({ failures = 1, code = 3, beforeMetadata = false, zeroDimensions = false, platform = 'darwin' }) => {
      globalThis.openlrNativePlatform = platform
      const prototype = HTMLMediaElement.prototype
      const src = Object.getOwnPropertyDescriptor(prototype, 'src')
      const { createObjectURL, revokeObjectURL } = URL
      const files = new Map(),
        revoked = new Set(),
        players = [],
        metadata = [],
        loaded = []
      URL.createObjectURL = function (file) {
        const url = createObjectURL.call(this, file)
        files.set(url, file)
        return url
      }
      URL.revokeObjectURL = function (url) {
        revoked.add(url)
        return revokeObjectURL.call(this, url)
      }
      Object.defineProperty(prototype, 'src', {
        ...src,
        set(url) {
          const previous = players.at(-1)
          const entry = {
            video: this,
            url,
            previousReleased: !previous || (!previous.video.hasAttribute('src') && revoked.has(previous.url))
          }
          players.push(entry)
          this.addEventListener(
            'loadedmetadata',
            (event) =>
              metadata.push({ trusted: event.isTrusted, width: this.videoWidth, height: this.videoHeight }),
            { once: true }
          )
          this.addEventListener('loadeddata', (event) => loaded.push(event.isTrusted), { once: true })
          const fail = () => {
            Object.defineProperty(this, 'error', {
              value: { code, message: 'Controlled initial decode failure ' + players.indexOf(entry) }
            })
            this.dispatchEvent(new Event('error'))
          }
          if (players.length <= failures) {
            if (zeroDimensions) Object.defineProperty(this, 'videoWidth', { value: 0 })
            if (!beforeMetadata) this.addEventListener('loadedmetadata', fail, { once: true })
          }
          src.set.call(this, url)
          if (players.length <= failures && beforeMetadata) fail()
        }
      })
      window.videoLoadProbe = {
        read: () => ({
          attempts: players.length,
          released: players.map(({ video, url }) => !video.hasAttribute('src') && revoked.has(url)),
          previousReleased: players.map(({ previousReleased }) => previousReleased),
          sameFile: players.every(({ url }) => files.get(url) === files.get(players[0].url)),
          metadata,
          loaded
        }),
        restore() {
          Object.defineProperty(prototype, 'src', src)
          URL.createObjectURL = createObjectURL
          URL.revokeObjectURL = revokeObjectURL
        }
      }
    },
    options
  )
}

test('macOS initial decode recovery uses one fresh player and saves one real trim', async (t) => {
  const { page, bytes } = await workspace(t)
  const id = await page.evaluate(async (bytes) => {
    const result = await window.openlr.run('import', {
      files: [new File([Uint8Array.from(bytes)], 'recover.webm', { type: 'video/webm' })]
    })
    if (result.failed.length) throw Error(result.failed[0].error)
    return result.added[0]
  }, bytes)
  await interceptLoads(page)
  const result = await page.evaluate(async (id) => {
    const run = window.openlr.run
    const db = await import('./catalog.js')
    const before = (await run('state')).photos.find((photo) => photo.id === id).edit
    try {
      const trimmed = await run('video-trim', { start: 2.1, end: 2.8, photoId: id })
      const saved = (await db.all('photos')).find((photo) => photo.id === id).edit
      const { blob } = await run('preview')
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(1, 1),
        context = canvas.getContext('2d')
      context.drawImage(bitmap, 0, 0, 1, 1)
      bitmap.close()
      const pixel = Array.from(context.getImageData(0, 0, 1, 1).data)
      const stage = document.querySelector('#stage canvas')
      const displayedPixel = Array.from(
        stage.getContext('2d').getImageData(stage.width >> 1, stage.height >> 1, 1, 1).data
      )
      const presentation = {
        galleryHidden: document.querySelector('#gallery').hidden,
        stageHidden: document.querySelector('#stage').hidden
      }
      const undone = (await run('undo')).photos.find((photo) => photo.id === id).edit
      const twiceUndone = (await run('undo')).photos.find((photo) => photo.id === id).edit
      const redone = (await run('redo')).photos.find((photo) => photo.id === id).edit
      const original = Array.from(
        new Uint8Array(await (await run('export', { format: 'original' })).blob.arrayBuffer())
      )
      const active = window.videoLoadProbe.read()
      await run('library')
      return {
        before,
        trimmed,
        saved,
        pixel,
        displayedPixel,
        presentation,
        undone,
        twiceUndone,
        redone,
        original,
        active,
        closed: window.videoLoadProbe.read()
      }
    } finally {
      window.videoLoadProbe.restore()
    }
  }, id)
  assert.equal(result.trimmed.mode, 'detail')
  assert.equal(result.trimmed.playback.time, 2.1)
  assert.deepEqual(result.presentation, { galleryHidden: true, stageHidden: false })
  assert.deepEqual(result.saved.trim, { start: 2.1, end: 2.8 })
  assert.deepEqual(result.undone, result.before)
  assert.deepEqual(result.twiceUndone, result.before)
  assert.deepEqual(result.redone, result.saved)
  assert.deepEqual(result.original, bytes)
  assert.equal(result.active.attempts, 2)
  assert.equal(result.active.sameFile, true)
  assert.deepEqual(result.active.previousReleased, [true, true])
  assert.deepEqual(result.active.released, [true, false])
  assert.deepEqual(result.active.metadata, Array(2).fill({ trusted: true, width: 96, height: 64 }))
  assert.deepEqual(result.active.loaded, [true])
  assert.deepEqual(result.closed.released, [true, true])
  for (const pixel of [result.pixel, result.displayedPixel]) {
    const [red, green, blue, alpha] = pixel
    assert.ok(red < 100 && green < 100 && blue > 130 && alpha === 255, JSON.stringify(pixel))
  }
})

test('persistent macOS initial decode failure stops after two players and preserves Grid and the catalog', async (t) => {
  const { page, bytes } = await workspace(t)
  const id = await page.evaluate(async (bytes) => {
    const result = await window.openlr.run('import', {
      files: [new File([Uint8Array.from(bytes)], 'persistent.webm', { type: 'video/webm' })]
    })
    if (result.failed.length) throw Error(result.failed[0].error)
    return result.added[0]
  }, bytes)
  await interceptLoads(page, { failures: 2 })
  const result = await page.evaluate(async (id) => {
    const run = window.openlr.run,
      db = await import('./catalog.js')
    const before = await run('state')
    try {
      const error = await run('video-trim', { start: 0.5, end: 1.5, photoId: id }).catch(
        ({ message }) => message
      )
      const after = await run('state')
      const saved = (await db.all('photos')).find((photo) => photo.id === id).edit
      const original = Array.from(new Uint8Array(await (await db.original(id)).file.arrayBuffer()))
      const presentation = {
        galleryHidden: document.querySelector('#gallery').hidden,
        stageHidden: document.querySelector('#stage').hidden
      }
      const undone = await run('undo')
      return {
        before,
        after,
        error,
        saved,
        original,
        presentation,
        undone,
        probe: window.videoLoadProbe.read()
      }
    } finally {
      window.videoLoadProbe.restore()
    }
  }, id)
  assert.equal(result.error, 'Controlled initial decode failure 1')
  assert.equal(result.after.mode, 'grid')
  assert.equal(result.after.playback, null)
  assert.equal(result.after.selected, result.before.selected)
  assert.deepEqual(result.after.photos, result.before.photos)
  assert.deepEqual(result.undone.photos, result.before.photos)
  assert.deepEqual(result.saved, result.before.photos[0].edit)
  assert.deepEqual(result.original, bytes)
  assert.deepEqual(result.presentation, { galleryHidden: false, stageHidden: true })
  assert.equal(await page.locator('#gallery').isVisible(), true)
  assert.equal(await page.locator('#stage').isVisible(), false)
  assert.equal(result.probe.attempts, 2)
  assert.equal(result.probe.sameFile, true)
  assert.deepEqual(result.probe.previousReleased, [true, true])
  assert.deepEqual(result.probe.released, [true, true])
  assert.deepEqual(result.probe.loaded, [])
  assert.deepEqual(result.probe.metadata, Array(2).fill({ trusted: true, width: 96, height: 64 }))
})

test('initial decode recovery excludes other errors, unadmitted sources, posters and other platforms', async (t) => {
  const { page, bytes } = await workspace(t)
  for (const [name, options] of [
    ['aborted', { code: 1 }],
    ['network', { code: 2 }],
    ['unsupported', { code: 4 }],
    ['before metadata', { beforeMetadata: true }],
    ['zero dimensions', { zeroDimensions: true }],
    ['Windows', { platform: 'windows' }],
    ['poster', { preparePoster: true }]
  ]) {
    await t.test(name, async () => {
      await interceptLoads(page, options)
      const result = await page.evaluate(
        async ({ bytes, preparePoster }) => {
          const { openVideo } = await import('./video.js')
          try {
            const error = await openVideo(
              new File([Uint8Array.from(bytes)], 'control.webm', { type: 'video/webm' }),
              undefined,
              undefined,
              preparePoster
            ).catch(({ message }) => message)
            return { error, probe: window.videoLoadProbe.read() }
          } finally {
            window.videoLoadProbe.restore()
          }
        },
        { bytes, preparePoster: options.preparePoster }
      )
      assert.equal(result.error, 'Controlled initial decode failure 0')
      assert.equal(result.probe.attempts, 1)
      assert.deepEqual(result.probe.released, [true])
    })
  }
  await t.test('a later seek failure', async () => {
    await interceptLoads(page, { failures: 0 })
    const result = await page.evaluate(async (bytes) => {
      const { openVideo } = await import('./video.js')
      let media
      try {
        media = await openVideo(new File([Uint8Array.from(bytes)], 'seek.webm', { type: 'video/webm' }))
        const currentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
        Object.defineProperty(media.video, 'currentTime', {
          get: currentTime.get,
          set(value) {
            currentTime.set.call(this, value)
            Object.defineProperty(this, 'error', { value: { code: 3, message: 'Controlled seek failure' } })
            this.dispatchEvent(new Event('error'))
          }
        })
        const error = await media.seek(0.5).catch(({ message }) => message)
        media.close()
        return { error, probe: window.videoLoadProbe.read() }
      } finally {
        media?.close()
        window.videoLoadProbe.restore()
      }
    }, bytes)
    assert.equal(result.error, 'Controlled seek failure')
    assert.equal(result.probe.attempts, 1)
    assert.deepEqual(result.probe.released, [true])
  })
})
