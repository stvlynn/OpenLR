import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { waitForAsyncFunction } from './browser-wait.mjs'

let browser
before(async () => {
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
})
after(async () => {
  await browser?.close()
})

async function pageFor(t) {
  const page = await browser.newPage()
  t.after(() => page.close())
  return page
}

test('async browser wait continues after false and waits for a deferred true, unlike pinned Playwright', async (t) => {
  const page = await pageFor(t)
  const old = await page.waitForFunction(async () => {
    await Promise.resolve()
    return false
  })
  assert.equal(
    await old.jsonValue(),
    false,
    'The pinned implementation stops after the first false Promise result'
  )
  await old.dispose()
  await page.evaluate(() => {
    window.waitProbe = { calls: 0, active: 0, maximumActive: 0 }
  })
  let settled = false
  const waiting = waitForAsyncFunction(
    page,
    async ({ expected }) => {
      const probe = window.waitProbe
      probe.calls++
      probe.active++
      probe.maximumActive = Math.max(probe.maximumActive, probe.active)
      try {
        await Promise.resolve()
        if (probe.calls === 1) return false
        return await new Promise((resolve) => {
          probe.release = () => resolve(expected)
        })
      } finally {
        probe.active--
      }
    },
    { expected: { ready: true } },
    { timeout: 5000 }
  ).then((value) => {
    settled = true
    return value
  })
  // This synchronous marker appears only in evaluation two, after the first
  // asynchronous false result. No timing delay or repeated test is needed.
  await page.waitForFunction(() => Boolean(window.waitProbe.release))
  assert.equal(settled, false)
  assert.deepEqual(
    await page.evaluate(() => [window.waitProbe.calls, window.waitProbe.maximumActive]),
    [2, 1]
  )
  await page.evaluate(() => window.waitProbe.release())
  assert.deepEqual(await waiting, { ready: true })
  assert.equal(await page.evaluate(() => window.waitProbe.active), 0)
})

test('numeric polling awaits all falsy browser results and returns the first matching value', async (t) => {
  const page = await pageFor(t)
  await page.evaluate(() => {
    window.falsyResults = [false, 0, '', null]
    window.pollCalls = 0
  })
  const value = await waitForAsyncFunction(
    page,
    async (expected) => {
      window.pollCalls++
      await Promise.resolve()
      return window.falsyResults.length ? window.falsyResults.shift() : expected
    },
    'matched',
    { polling: 1, timeout: 5000 }
  )
  assert.equal(value, 'matched')
  assert.equal(await page.evaluate(() => window.pollCalls), 5)
})

test('a permanently false predicate has a bounded deadline and useful timeout diagnostics', async () => {
  // The transport stub makes the deadline test independent of browser startup
  // load. Actual Promise evaluation and polling are exercised above in Chrome.
  let calls = 0
  const page = {
    evaluate: async () => {
      calls++
      return false
    }
  }
  await assert.rejects(
    waitForAsyncFunction(page, () => false, undefined, { polling: 1, timeout: 30 }),
    (error) => {
      assert.equal(error.name, 'TimeoutError')
      assert.equal(error.code, 'BROWSER_WAIT_TIMEOUT')
      assert.match(error.message, /timed out after 30 ms/)
      assert.match(error.message, /last result: false/)
      return true
    }
  )
  assert.ok(calls >= 1)
})

test('the deadline also bounds a pending predicate and its late result cannot start another poll', async () => {
  let calls = 0,
    release
  const page = {
    evaluate: () => {
      calls++
      return new Promise((resolve) => {
        release = resolve
      })
    }
  }
  await assert.rejects(
    waitForAsyncFunction(page, () => false, undefined, { polling: 1, timeout: 30 }),
    (error) => {
      assert.equal(error.code, 'BROWSER_WAIT_TIMEOUT')
      assert.match(error.message, /predicate still pending/)
      return true
    }
  )
  assert.equal(calls, 1)
  release(false)
  await Promise.resolve()
  assert.equal(calls, 1)
})

test('browser read failures propagate on the first synchronous or asynchronous evaluation', async (t) => {
  const page = await pageFor(t)
  for (const predicate of [
    () => {
      window.readCalls++
      throw Error('Synchronous state read failed')
    },
    async () => {
      window.readCalls++
      await Promise.resolve()
      throw Error('Asynchronous state read failed')
    }
  ]) {
    await page.evaluate(() => {
      window.readCalls = 0
    })
    await assert.rejects(waitForAsyncFunction(page, predicate), /state read failed/)
    assert.equal(await page.evaluate(() => window.readCalls), 1)
  }
  const failure = Error('Transport disconnected')
  await assert.rejects(
    waitForAsyncFunction(
      {
        evaluate: () => {
          throw failure
        }
      },
      () => true
    ),
    (error) => error === failure
  )
})

test('default options work and invalid polling or unbounded deadlines fail before evaluation', async () => {
  let calls = 0
  const page = {
    evaluate: async (_predicate, arg) => {
      calls++
      return arg
    }
  }
  assert.deepEqual(await waitForAsyncFunction(page, () => true, { matched: true }), { matched: true })
  for (const options of [
    { timeout: 0 },
    { timeout: -1 },
    { timeout: Infinity },
    { timeout: 2 ** 31 },
    { polling: 0 },
    { polling: -1 },
    { polling: Infinity },
    { polling: 'bad' }
  ])
    await assert.rejects(
      waitForAsyncFunction(page, () => true, null, options),
      TypeError
    )
  await assert.rejects(waitForAsyncFunction(page, 'true'), /predicate must be a function/)
  assert.equal(calls, 1)
})
