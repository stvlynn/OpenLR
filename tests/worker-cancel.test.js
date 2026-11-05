import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

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
