import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('worker input allocation waits for admission and survives startup fallback without detaching originals', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const facts = await page.evaluate(async () => {
    const { runImageWorker } = await import('./image-worker.js')
    const url = new URL(
      URL.createObjectURL(
        new Blob(
          [
            'self.onmessage=({data})=>self.postMessage({bytes:Array.from(data.bytes)});self.postMessage({ready:true})'
          ],
          { type: 'text/javascript' }
        )
      )
    )
    const NativeWorker = window.Worker
    window.Worker = class {
      constructor() {
        throw Error('startup fixture')
      }
    }
    let release,
      entered = false,
      allocations = 0
    const blocking = runImageWorker(url, {}, [], async () => {
      entered = true
      await new Promise((resolve) => {
        release = resolve
      })
      return {}
    })
    while (!entered) await new Promise((resolve) => setTimeout(resolve, 1))
    window.Worker = NativeWorker
    const original = new Uint8Array([3, 5, 7])
    const prepareMessage = (bytes) => {
      allocations++
      const copy = bytes.slice()
      return { message: { bytes: copy }, transfers: [copy.buffer] }
    }
    const controller = new AbortController()
    const canceled = runImageWorker(url, original, [], undefined, {
      signal: controller.signal,
      prepareMessage
    }).catch((error) => error.code)
    const admitted = runImageWorker(url, original, [], undefined, { prepareMessage })
    controller.abort()
    const canceledCode = await canceled
    const allocationsWhileBlocked = allocations
    release()
    await blocking
    const result = await admitted
    window.Worker = class {
      constructor() {
        throw Error('startup fixture')
      }
    }
    const fallback = await runImageWorker(url, original, [], ({ bytes }) => ({ bytes: Array.from(bytes) }), {
      prepareMessage
    })
    let preparationFallbacks = 0
    const failed = await runImageWorker(
      url,
      original,
      [],
      () => {
        preparationFallbacks++
      },
      {
        prepareMessage: () => {
          throw Error('allocation fixture')
        }
      }
    ).catch((error) => error.message)
    window.Worker = NativeWorker
    const recovered = await runImageWorker(url, original, [], undefined, { prepareMessage })
    URL.revokeObjectURL(url.href)
    return {
      allocationsWhileBlocked,
      allocations,
      canceledCode,
      result,
      fallback,
      failed,
      preparationFallbacks,
      recovered,
      original: Array.from(original)
    }
  })
  assert.equal(facts.allocationsWhileBlocked, 0)
  assert.equal(facts.allocations, 3)
  assert.equal(facts.canceledCode, 'ABORTED')
  for (const value of [facts.result, facts.fallback, facts.recovered])
    assert.deepEqual(value, { bytes: [3, 5, 7] })
  assert.deepEqual(facts.original, [3, 5, 7])
  assert.equal(facts.failed, 'allocation fixture')
  assert.equal(facts.preparationFallbacks, 0)
})

test('shared worker queue cancels queued, pre-handshake and active work without fallback or queue overlap', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const facts = await page.evaluate(async () => {
    const { runImageWorker } = await import('./image-worker.js')
    const workerUrl = new URL(
      URL.createObjectURL(
        new Blob(
          [
            `
      self.onmessage = ({data}) => {
        if (data.hang) return
        setTimeout(() => self.postMessage({value:data.value}), data.delay || 0)
      }
      self.postMessage({ready:true})
    `
          ],
          { type: 'text/javascript' }
        )
      )
    )
    const silentUrl = new URL(
      URL.createObjectURL(new Blob(['self.onmessage=()=>{}'], { type: 'text/javascript' }))
    )
    const errors = [],
      results = []
    let fallbacks = 0
    const fallback = () => {
      fallbacks++
      return {}
    }
    const capture = (promise) =>
      promise.catch((error) => {
        errors.push([error.name, error.code])
        return 'aborted'
      })
    const waitUntil = async (condition) => {
      const start = performance.now()
      while (!condition()) {
        if (performance.now() - start > 5000) throw Error('Worker did not reach the expected phase')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    const activeController = new AbortController(),
      activeBytes = new Uint8Array([1, 2, 3])
    const active = capture(
      runImageWorker(workerUrl, { hang: true, bytes: activeBytes }, [activeBytes.buffer], fallback, {
        signal: activeController.signal
      })
    )
    await waitUntil(() => activeBytes.byteLength === 0)
    const queuedController = new AbortController(),
      queuedBytes = new Uint8Array([4, 5, 6])
    const queued = capture(
      runImageWorker(workerUrl, { bytes: queuedBytes }, [queuedBytes.buffer], fallback, {
        signal: queuedController.signal
      })
    )
    queuedController.abort()
    results.push(await queued)
    const queuedAttached = Array.from(queuedBytes)
    activeController.abort()
    results.push(await active)
    const pre = new AbortController(),
      preBytes = new Uint8Array([7, 8])
    const preJob = capture(
      runImageWorker(silentUrl, { bytes: preBytes }, [preBytes.buffer], fallback, { signal: pre.signal })
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    pre.abort()
    results.push(await preJob)
    const preAttached = Array.from(preBytes)
    const already = new AbortController()
    already.abort()
    results.push(await capture(runImageWorker(workerUrl, {}, [], fallback, { signal: already.signal })))
    const recovered = await runImageWorker(workerUrl, { value: 42 })
    // A canceled asynchronous startup fallback must retain its queue slot until
    // it actually finishes; otherwise another large image heap can overlap it.
    const NativeWorker = window.Worker
    window.Worker = class {
      constructor() {
        throw Error('fixture startup failure')
      }
    }
    const fallbackController = new AbortController()
    let release,
      entered = false,
      settled = false
    const fallbackJob = capture(
      runImageWorker(
        workerUrl,
        {},
        [],
        async () => {
          entered = true
          await new Promise((resolve) => {
            release = resolve
          })
          settled = true
          return { value: 0 }
        },
        { signal: fallbackController.signal }
      )
    )
    await waitUntil(() => entered)
    window.Worker = NativeWorker
    fallbackController.abort()
    results.push(await fallbackJob)
    let nextDone = false
    const next = runImageWorker(workerUrl, { value: 99 }).then((value) => {
      nextDone = true
      return value
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const overlap = nextDone || settled
    release()
    const nextResult = await next
    URL.revokeObjectURL(workerUrl.href)
    URL.revokeObjectURL(silentUrl.href)
    return {
      errors,
      results,
      fallbacks,
      queuedAttached,
      preAttached,
      recovered,
      nextResult,
      overlap,
      settled
    }
  })
  assert.deepEqual(facts.results, Array(5).fill('aborted'))
  assert.deepEqual(facts.errors, Array(5).fill(['AbortError', 'ABORTED']))
  assert.equal(facts.fallbacks, 0)
  assert.deepEqual(facts.queuedAttached, [4, 5, 6])
  assert.deepEqual(facts.preAttached, [7, 8])
  assert.deepEqual(facts.recovered, { value: 42 })
  assert.deepEqual(facts.nextResult, { value: 99 })
  assert.equal(facts.overlap, false)
  assert.equal(facts.settled, true)
})
