import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('byte-input analysis transfers only owned bytes and matches scalar preparation and startup fallback', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const facts = await page.evaluate(async () => {
    const { analyzeDehazeOwned } = await import('./dehaze-worker-client.js')
    const { analyzeDehaze } = await import('./dehaze.js')
    const { rgba8ToLinearFrame } = await import('./pixel-frame.js')
    const data = Uint8ClampedArray.from({ length: 64 * 48 * 4 }, (_, i) => (i * 17 + Math.floor(i / 4)) % 256)
    const input = { width: 64, height: 48, data },
      before = data.slice(),
      cases = []
    for (const transmission of [false, true]) {
      const linear = rgba8ToLinearFrame(input),
        expected = analyzeDehaze(linear, { transmission })
      const owned = { ...input, data: data.slice() }
      const actual = await analyzeDehazeOwned(owned, { encoding: 'rgba8', transmission })
      cases.push(
        owned.data.byteLength === 0 &&
          actual.frame.colorSpace === 'srgb-linear' &&
          actual.frame.data.every((v, i) => v === linear.data[i]) &&
          actual.analysis.airlight.every((v, i) => v === expected.airlight[i]) &&
          (transmission
            ? actual.analysis.transmission.every((v, i) => v === expected.transmission[i])
            : actual.analysis.transmission === null)
      )
    }
    const NativeWorker = window.Worker
    window.Worker = class {
      constructor() {
        throw Error('byte-input startup fixture')
      }
    }
    const fallback = await analyzeDehazeOwned(input, { encoding: 'rgba8' })
    window.Worker = NativeWorker
    const expected = rgba8ToLinearFrame(input)
    const failure = await analyzeDehazeOwned(
      { width: 1, height: 1, data: new Uint8Array(3) },
      { encoding: 'rgba8' }
    ).catch((e) => e.message)
    const retry = await analyzeDehazeOwned({ ...input, data: data.slice() }, { encoding: 'rgba8' })
    return {
      cases,
      preserved: data.every((v, i) => v === before[i]),
      fallback: fallback.frame.data.every((v, i) => v === expected.data[i]),
      retry: retry.frame.data.every((v, i) => v === expected.data[i]),
      failure
    }
  })
  assert.ok(facts.cases.every(Boolean))
  assert.ok(facts.preserved && facts.fallback && facts.retry)
  assert.match(facts.failure, /dimensions/)
})

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
