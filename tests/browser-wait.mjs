import { inspect } from 'node:util'

const MAX_TIMER_DELAY = 2_147_483_647

/**
 * Await each browser predicate result before testing its truthiness. The pinned
 * Playwright waitForFunction instead treats an async predicate's Promise as a
 * match, even when it subsequently resolves false. Returns the matching value,
 * not a JSHandle. Arguments otherwise follow waitForFunction(predicate,arg,options).
 *
 * Polling uses animation frames by default, or a positive numeric interval in
 * milliseconds. The Node timer is a bounded state-polling cadence, not a retry
 * of failed actions: predicate/evaluation errors propagate on their first call.
 */
export async function waitForAsyncFunction(page, predicate, arg, options = {}) {
  const { timeout = 30_000, polling = 'raf' } = options
  if (typeof predicate !== 'function') throw new TypeError('Browser wait predicate must be a function')
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMER_DELAY)
    throw new TypeError('Browser wait timeout must be positive and fit a Node timer')
  if (polling !== 'raf' && (!Number.isFinite(polling) || polling <= 0 || polling > MAX_TIMER_DELAY))
    throw new TypeError('Browser wait polling must be "raf" or a positive Node timer interval')

  const deadline = performance.now() + timeout
  let stopped = false,
    pending = false,
    attempts = 0,
    lastResult,
    deadlineTimer,
    pollingTimer
  const timedOut = () =>
    Object.assign(
      new Error(
        `waitForAsyncFunction timed out after ${timeout} ms (${attempts} evaluations; ${pending ? 'predicate still pending' : 'last result: ' + inspect(lastResult, { depth: 1, maxArrayLength: 8, maxStringLength: 120 })})`
      ),
      { name: 'TimeoutError', code: 'BROWSER_WAIT_TIMEOUT' }
    )

  const poll = async () => {
    for (;;) {
      if (stopped || performance.now() >= deadline) throw timedOut()
      attempts++
      pending = true
      // page.evaluate awaits a returned browser Promise before it returns.
      const result = await page.evaluate(predicate, arg)
      pending = false
      lastResult = result
      if (stopped || performance.now() >= deadline) throw timedOut()
      if (result) return result
      if (polling === 'raf') await page.evaluate(() => new Promise(requestAnimationFrame))
      else
        await new Promise((resolve) => {
          pollingTimer = setTimeout(resolve, polling)
        })
    }
  }
  try {
    // This deadline also bounds a predicate or animation frame that never
    // settles. Late evaluations cannot start another poll after completion.
    return await Promise.race([
      poll(),
      new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => reject(timedOut()), timeout)
      })
    ])
  } finally {
    stopped = true
    clearTimeout(deadlineTimer)
    clearTimeout(pollingTimer)
  }
}
