import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('exact dehaze worker returns owned pixels/maps, stays responsive and recovers after active cancellation', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const { analyzeDehazeOwned } = await import('./dehaze-worker-client.js')
    const { analyzeDehaze } = await import('./dehaze.js')
    const frame = (width, height) => {
      const data = new Float32Array(width * height * 4)
      for (let i = 0; i < width * height; i++)
        data.set(
          [
            0.2 + (i % 11) / 20,
            0.3 + (i % 7) / 15,
            0.4 + (i % 3) / 8,
            i % 9 === 0 ? 0 : i % 5 === 0 ? 0.25 : 1
          ],
          i * 4
        )
      return { width, height, data, colorSpace: 'srgb-linear' }
    }
    const cases = []
    for (const transmission of [false, true]) {
      const source = frame(71, 53),
        before = source.data.slice()
      source.data.set([-2, 4, 0.2, 0.25], 4)
      before.set(source.data.slice(4, 8), 4)
      const expected = analyzeDehaze(source, { transmission })
      const actual = await analyzeDehazeOwned(source, { transmission })
      cases.push({
        detached: source.data.byteLength === 0,
        source: actual.frame.data.every((v, i) => v === before[i]),
        air: actual.analysis.airlight.every((v, i) => v === expected.airlight[i]),
        map: transmission
          ? actual.analysis.transmission.every((v, i) => v === expected.transmission[i])
          : actual.analysis.transmission === null
      })
    }
    const original = frame(2048, 1536),
      owned = { ...original, data: original.data.slice() }
    let ticks = 0
    const heartbeat = setInterval(() => ticks++, 10)
    const start = performance.now()
    const completed = await analyzeDehazeOwned(owned)
    const duration = performance.now() - start
    clearInterval(heartbeat)
    const attachedOriginal = original.data.byteLength
    const controller = new AbortController(),
      canceledCopy = { ...original, data: original.data.slice() }
    const canceled = analyzeDehazeOwned(canceledCopy, { signal: controller.signal }).then(
      () => '',
      (e) => e.name
    )
    const deadline = performance.now() + 5000
    while (canceledCopy.data.byteLength && performance.now() < deadline)
      await new Promise((r) => setTimeout(r, 2))
    if (canceledCopy.data.byteLength) throw Error('Worker handoff was not observed')
    controller.abort()
    const cancellation = await canceled
    const retry = await analyzeDehazeOwned(frame(3, 2))
    const NativeWorker = window.Worker
    window.Worker = class {
      constructor() {
        throw Error('fixture unavailable worker')
      }
    }
    const fallbackSource = frame(9, 7),
      fallbackBefore = fallbackSource.data.slice()
    const fallback = await analyzeDehazeOwned(fallbackSource)
    window.Worker = NativeWorker
    return {
      cases,
      ticks,
      duration,
      attachedOriginal,
      completedSamples: completed.frame.data.length,
      cancellation,
      retry: retry.analysis.visible,
      fallbackAttached: fallbackSource.data.byteLength,
      fallbackExact: fallback.frame.data.every((v, i) => v === fallbackBefore[i])
    }
  })
  assert.ok(result.cases.every((c) => c.detached && c.source && c.air && c.map))
  assert.ok(result.ticks >= 3, JSON.stringify(result))
  assert.equal(result.attachedOriginal, 2048 * 1536 * 16)
  assert.equal(result.completedSamples, 2048 * 1536 * 4)
  assert.equal(result.cancellation, 'AbortError')
  assert.ok(result.retry > 0)
  assert.equal(result.fallbackAttached, 9 * 7 * 16)
  assert.equal(result.fallbackExact, true)
  t.diagnostic(JSON.stringify({ heartbeatTicks: result.ticks, workerMilliseconds: result.duration }))
})
