import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('background dehaze encoding preserves shared snapshots, exact previews, cancellation and fallback', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const { encodeDehaze } = await import('./dehaze-worker-client.js')
    const { analyzeDehaze, createDehazePixel } = await import('./dehaze.js')
    const { linearFrameToRgba8 } = await import('./pixel-frame.js')
    const { render, renderPrepared } = await import('./render.js')
    const frame = {
      width: 97,
      height: 61,
      colorSpace: 'srgb-linear',
      data: Float32Array.from({ length: 97 * 61 * 4 }, (_, i) =>
        i % 4 === 3 ? (i % 11 === 0 ? 0 : 0.5) : -0.1 + (i % 43) / 25
      )
    }
    const before = frame.data.slice(),
      comparisons = []
    for (const amount of [-60, 40, 100]) {
      const analysis = analyzeDehaze(frame, { transmission: amount > 0 })
      const map = analysis.transmission?.slice()
      const actual = (await encodeDehaze(frame, analysis, amount)).pixels
      const expected = linearFrameToRgba8(frame, createDehazePixel(amount, analysis))
      comparisons.push(
        actual.data.every((v, i) => v === expected.data[i]) &&
          (!map || analysis.transmission.every((v, i) => v === map[i]))
      )
    }
    const canvas = document.createElement('canvas')
    canvas.width = 97
    canvas.height = 61
    const ctx = canvas.getContext('2d')
    ctx.putImageData(new ImageData(linearFrameToRgba8(frame).data, 97, 61), 0, 0)
    const bitmap = await createImageBitmap(canvas)
    const bytes = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    for (const amount of [-60, 40, 100]) {
      const edit = {
        Dehaze: amount,
        Exposure: 0.2,
        turn: 1,
        flip: true,
        crop: { x: 0.1, y: 0.2, w: 0.8, h: 0.7 }
      }
      const actual = await renderPrepared(bitmap, edit, 45),
        expected = render(bitmap, edit, 45)
      const a = bytes(actual),
        b = bytes(expected)
      comparisons.push(
        actual.width === expected.width && actual.height === expected.height && a.every((v, i) => v === b[i])
      )
    }
    const NativeWorker = window.Worker
    let handed = false,
      terminated = false
    const urls = []
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (url.pathname.endsWith('dehaze-encode-worker.js')) {
          const blob = URL.createObjectURL(
            new Blob(['self.onmessage=()=>{};self.postMessage({ready:true})'], { type: 'text/javascript' })
          )
          urls.push(blob)
          super(blob, options)
        } else super(url, options)
      }
      postMessage(message, transfers) {
        super.postMessage(message, transfers)
        handed = true
      }
      terminate() {
        terminated = true
        super.terminate()
      }
    }
    const analysis = analyzeDehaze(frame),
      controller = new AbortController()
    const canceled = encodeDehaze(frame, analysis, 50, { signal: controller.signal }).catch((e) => e.name)
    const deadline = performance.now() + 5000
    while (!handed && performance.now() < deadline) await new Promise((r) => setTimeout(r, 2))
    if (!handed) throw Error('Encoding handoff not observed')
    controller.abort()
    const abortResult = await canceled
    window.Worker = class {
      constructor() {
        throw Error('encoding startup fixture')
      }
    }
    const fallback = (await encodeDehaze(frame, analysis, 50)).pixels
    window.Worker = NativeWorker
    const retry = (await encodeDehaze(frame, analysis, 50)).pixels
    const expected = linearFrameToRgba8(frame, createDehazePixel(50, analysis))
    comparisons.push(
      fallback.data.every((v, i) => v === expected.data[i]),
      retry.data.every((v, i) => v === expected.data[i])
    )
    const preserved = frame.data.every((v, i) => v === before[i]) && analysis.transmission.length === 97 * 61
    bitmap.close()
    urls.forEach(URL.revokeObjectURL)
    return { comparisons, preserved, abortResult, terminated }
  })
  assert.ok(result.comparisons.every(Boolean), JSON.stringify(result))
  assert.equal(result.preserved, true)
  assert.equal(result.abortResult, 'AbortError')
  assert.equal(result.terminated, true)
})
