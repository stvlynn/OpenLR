import { waitForAsyncFunction } from './browser-wait.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { serveWorkspace } from './browser-server.mjs'
import { chromium } from 'playwright-core'
import { makeDng } from './fixtures/dng.mjs'

test('real WASM decodes generated sensor DNG, orientation, recovery and bitmap ownership', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const fixture = Array.from(makeDng()),
    rotated = Array.from(makeDng({ orientation: 6 }))
  const result = await page.evaluate(
    async ({ fixture, rotated }) => {
      const { decodePhoto, decodePhotoLinear } = await import('./decode.js')
      const NativeWorker = window.Worker
      let workers = 0,
        terminated = 0,
        live = 0,
        maxLive = 0
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args)
          workers++
          live++
          maxLive = Math.max(live, maxLive)
        }
        terminate() {
          terminated++
          live--
          super.terminate()
        }
      }
      const file = new File([new Uint8Array(fixture)], 'sensor.dng', { type: 'image/x-adobe-dng' })
      const before = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      const bitmap = await decodePhoto(file)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')
      context.drawImage(bitmap, 0, 0)
      const pixels = [16, 64, 112].map((x) => Array.from(context.getImageData(x, 48, 1, 1).data))
      const dimensions = [bitmap.width, bitmap.height]
      bitmap.close()
      let invalidCode
      try {
        await decodePhoto(new File(['not a raw'], 'bad.dng'))
      } catch (error) {
        invalidCode = error.code
      }
      const two = await decodePhoto(new File([new Uint8Array(rotated)], 'rotate.dng'))
      const rotatedDimensions = [two.width, two.height]
      two.close()
      const retry = await decodePhoto(file)
      const recovered = [retry.width, retry.height]
      retry.close()
      const parallel = await Promise.all([decodePhoto(file), decodePhoto(file)])
      parallel.forEach((image) => image.close())
      const limits = []
      for (const input of [new File([], 'empty.dng')]) {
        try {
          await decodePhoto(input)
        } catch (error) {
          limits.push(error.code)
        }
      }
      const after = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      const linear = await decodePhotoLinear(file)
      const displayed = context.getImageData(0, 0, canvas.width, canvas.height).data
      let displayMaximumError = 0,
        linearPreviewDifference = 0
      for (let i = 0; i < linear.linear.length; i++) {
        const value = linear.linear[i],
          expected = Math.round(
            255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055)
          ),
          rgbaIndex = Math.floor(i / 3) * 4 + (i % 3)
        displayMaximumError = Math.max(displayMaximumError, Math.abs(displayed[rgbaIndex] - expected))
        linearPreviewDifference = Math.max(
          linearPreviewDifference,
          Math.abs(displayed[rgbaIndex] - linear.data[rgbaIndex])
        )
      }
      const linearFacts = {
        width: linear.width,
        height: linear.height,
        samples: linear.linear.length,
        rgba: linear.data.length,
        sub8bit: Array.from(linear.linear).some(
          (value) => value > 0 && value < 1 && Math.abs(value * 255 - Math.round(value * 255)) > 0.01
        )
      }
      window.Worker = NativeWorker
      return {
        dimensions,
        rotatedDimensions,
        pixels,
        invalidCode,
        recovered,
        limits,
        workers,
        terminated,
        maxLive,
        linearFacts,
        displayMaximumError,
        linearPreviewDifference,
        unchanged: String(new Uint8Array(before)) === String(new Uint8Array(after)),
        closedWidth: bitmap.width
      }
    },
    { fixture, rotated }
  )
  assert.deepEqual(result.dimensions, [128, 96])
  assert.deepEqual(result.rotatedDimensions, [96, 128])
  assert.deepEqual(result.recovered, [128, 96])
  assert.equal(result.invalidCode, 'RAW_DECODE')
  assert.equal(result.unchanged, true)
  assert.equal(result.closedWidth, 0)
  assert.deepEqual(result.limits, ['EMPTY'])
  assert.equal(result.workers, 7)
  assert.equal(result.terminated, 7)
  assert.deepEqual(result.linearFacts, {
    width: 128,
    height: 96,
    samples: 128 * 96 * 3,
    rgba: 128 * 96 * 4,
    sub8bit: true
  })
  assert.equal(result.maxLive, 1)
  assert.ok(result.displayMaximumError <= 1, JSON.stringify(result))
  assert.equal(result.linearPreviewDifference, 0)
  const [red, green, blue] = result.pixels
  assert.ok(red[0] > red[2] + 40, JSON.stringify(result))
  assert.ok(green[1] > green[0] + 40, JSON.stringify(result))
  assert.ok(blue[2] > blue[0] + 40, JSON.stringify(result))
  console.log('RAW decode result:', JSON.stringify(result))
})

test('legacy RAW thumbnails regenerate on visibility without changing originals or edits', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  for (const scenario of ['native visibility', 'queued row replacement', 'without IntersectionObserver']) {
    await t.test(scenario, async (t) => {
      const page = await browser.newPage()
      t.after(() => page.close())
      await page.goto(server.url)
      const id = await page.evaluate(async (bytes) => {
        const { run } = await import('./app.js'),
          db = await import('./catalog.js')
        const imported = await run('import', { files: [new File([new Uint8Array(bytes)], 'legacy.dng')] })
        const photo = (await db.all('photos')).find((p) => p.id === imported.added[0])
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 16
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ff00ff'
        ctx.fillRect(0, 0, 16, 16)
        photo.thumbnail = await new Promise((resolve) => canvas.toBlob(resolve))
        delete photo.rawPreviewVersion
        await db.save('photos', photo)
        return photo.id
      }, Array.from(makeDng()))
      if (scenario === 'queued row replacement')
        await page.addInitScript(() => {
          window.thumbnailObservers = []
          window.IntersectionObserver = class {
            constructor(callback) {
              this.callback = callback
            }
            observe(element) {
              this.element = element
              window.thumbnailObservers.push(this)
            }
            disconnect() {
              this.disconnected = true
            }
          }
        })
      else if (scenario === 'without IntersectionObserver')
        await page.addInitScript(() => {
          window.IntersectionObserver = undefined
        })
      await page.reload()
      if (scenario === 'queued row replacement')
        await page.evaluate(async () => {
          const { run } = await import('./app.js')
          await run('state')
          const rate = run('rate', { value: 1 })
          // Queue the old row's cache work behind a command that replaces that row.
          for (const observer of [...window.thumbnailObservers])
            if (!observer.disconnected && observer.element.isConnected)
              observer.callback([{ isIntersecting: true }])
          await rate
          await run('state')
          // A reused visible tile must observe its current row after the old job exits.
          for (const observer of [...window.thumbnailObservers])
            if (!observer.disconnected && observer.element.isConnected)
              observer.callback([{ isIntersecting: true }])
        })
      await waitForAsyncFunction(
        page,
        async (id) => {
          const { run } = await import('./app.js')
          return (await run('state')).photos.find((p) => p.id === id)?.rawPreviewVersion === 1
        },
        id
      )
      // Catalog persistence and the lazy <img> request complete separately.
      // decode() alone may refer to the old 16x16 request during src replacement.
      await page.waitForFunction((id) => {
        const image = document.querySelector(`[data-photo="${id}"] img`)
        return (
          image?.complete &&
          image.currentSrc === image.src &&
          image.naturalWidth === 128 &&
          image.naturalHeight === 96
        )
      }, id)
      const result = await page.evaluate(async (id) => {
        const { run } = await import('./app.js'),
          db = await import('./catalog.js')
        const image = document.querySelector(`[data-photo="${id}"] img`)
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        canvas.getContext('2d').drawImage(image, 0, 0)
        const pixel = Array.from(
          canvas
            .getContext('2d')
            .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
        )
        await run('select', { id })
        await run('rate', { value: 2 })
        const saved = (await db.all('photos')).find((p) => p.id === id)
        return {
          pixel,
          version: saved.rawPreviewVersion,
          edit: saved.edit,
          bytes: Array.from(new Uint8Array(await (await db.original(id)).file.arrayBuffer()))
        }
      }, id)
      assert.equal(result.version, 1)
      assert.deepEqual(result.edit, {})
      assert.deepEqual(result.bytes, Array.from(makeDng()))
      assert.ok(
        result.pixel[1] > result.pixel[0] + 40 && result.pixel[1] > result.pixel[2] + 40,
        JSON.stringify(result.pixel)
      )
    })
  }
})
