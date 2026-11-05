import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('Linear dehaze worker preserves signed samples, geometry, effects and shared snapshots across cancel and fallback', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const facts = await page.evaluate(async () => {
    const { renderFrame, renderFramePrepared, renderPrepared, frameCanvas, prepareDehaze } =
      await import('./render.js')
    const { renderDehazeFrame } = await import('./dehaze-worker-client.js')
    const { bindWorkingFrame } = await import('./working-frames.js')
    const { getImageWorkerDiagnostics } = await import('./image-worker.js')
    const input = {
      width: 97,
      height: 61,
      colorSpace: 'srgb-linear',
      data: Float32Array.from({ length: 97 * 61 * 4 }, (_, i) =>
        i % 4 === 3 ? (i % 13 === 0 ? 0 : 0.5) : -0.1 + (i % 43) / 25
      )
    }
    const before = input.data.slice(),
      equal = (a, b) =>
        a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i])
    const checks = []
    for (const Dehaze of [-60, 40, 100]) {
      const edit = {
        processVersion: 2,
        Dehaze,
        Exposure: 0.3,
        Contrast: 12,
        Saturation: 9,
        Clarity: 7,
        Sharpening: 8,
        crop: { x: 0.1, y: 0.2, w: 0.8, h: 0.7 },
        turn: 1,
        flip: true,
        colorGrading: { global: { hue: 220, saturation: 10, luminance: 2 } }
      }
      const actual = await renderFramePrepared(input, edit, 45),
        expected = renderFrame(input, edit, 45)
      checks.push(equal(actual, expected))
      const surface = bindWorkingFrame(await createImageBitmap(frameCanvas(input)), input)
      const preview = await renderPrepared(surface, edit, 45),
        oracle = frameCanvas(expected)
      const pixels = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height)
      checks.push(equal(pixels(preview), pixels(oracle)))
      surface.close()
    }
    const edit = { processVersion: 2, Dehaze: 50 },
      prepared = await prepareDehaze(input, edit)
    const source = prepared.source.data.slice(),
      map = prepared.analysis.transmission.slice()
    const concurrent = await Promise.all(
      [20, 70].map((Dehaze) => renderFramePrepared(input, { ...edit, Dehaze }, 48))
    )
    checks.push(
      concurrent.every((frame, i) => equal(frame, renderFrame(input, { ...edit, Dehaze: [20, 70][i] }, 48)))
    )
    const diagnostics = getImageWorkerDiagnostics()
    const NativeWorker = window.Worker,
      urls = []
    let handed = false,
      terminated = false
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (url.pathname.endsWith('dehaze-frame-worker.js')) {
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
    const controller = new AbortController()
    const canceled = renderFramePrepared(input, edit, 48, { signal: controller.signal }).catch((e) => e.name)
    while (!handed) await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    const cancellation = await canceled
    window.Worker = NativeWorker
    urls.forEach((url) => URL.revokeObjectURL(url))
    checks.push(equal(await renderFramePrepared(input, edit, 48), renderFrame(input, edit, 48)))
    window.Worker = class {
      constructor() {
        throw Error('Linear worker startup fixture')
      }
    }
    try {
      const fallback = await renderDehazeFrame(prepared.source, prepared.analysis, edit, 48, input)
      checks.push(equal(fallback.frame, renderFrame(input, edit, 48)))
    } finally {
      window.Worker = NativeWorker
    }
    return {
      checks,
      cancellation,
      terminated,
      diagnostics,
      preserved:
        input.data.every((v, i) => v === before[i]) &&
        prepared.source.data.every((v, i) => v === source[i]) &&
        prepared.analysis.transmission.every((v, i) => v === map[i])
    }
  })
  assert.ok(facts.checks.every(Boolean))
  assert.equal(facts.cancellation, 'AbortError')
  assert.ok(facts.terminated && facts.preserved)
  assert.deepEqual(facts.diagnostics, [])
})
