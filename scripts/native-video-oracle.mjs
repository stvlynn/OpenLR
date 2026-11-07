import assert from 'node:assert/strict'

function within(operation, milliseconds, message) {
  let timer
  return Promise.race([
    operation,
    new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(message), { code: 'VIDEO_ORACLE_DEADLINE' })),
        milliseconds
      )
    })
  ]).finally(() => clearTimeout(timer))
}

// Retain only the process returned by this launch's public BrowserServer API.
// A completed protocol close alone is not evidence that the browser exited.
export function ownVideoOracle(owner, { log = console.log, closeMs = 5000, killMs = 5000 } = {}) {
  const child = owner.process()
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, 'Video oracle requires an owned browser PID')
  const startedAt = performance.now()
  const report = (phase, details = {}) =>
    log(
      JSON.stringify({
        nativeVideoOracleCleanup: phase,
        elapsedMs: Math.round(performance.now() - startedAt),
        ...details
      })
    )
  let exit
  const exited = new Promise((resolve) => {
    const observe = (code, signal) => {
      if (exit) return
      exit = { code, signal }
      report('process-exited', exit)
      resolve(exit)
    }
    child.once('exit', observe)
    if (child.exitCode !== null || child.signalCode !== null) observe(child.exitCode, child.signalCode)
  })
  log(JSON.stringify({ nativeVideoOracle: 'owned', pid: child.pid }))
  let closing
  return {
    close() {
      return (closing ??= (async () => {
        report('started')
        try {
          let method = 'graceful'
          try {
            await within(
              Promise.all([Promise.resolve().then(() => owner.close()), exited]),
              closeMs,
              'Video oracle graceful shutdown exceeded its deadline'
            )
          } catch (error) {
            report(error.code === 'VIDEO_ORACLE_DEADLINE' ? 'close-deadline' : 'close-failed')
            report('kill-requested')
            method = 'killed'
            await within(
              Promise.all([Promise.resolve().then(() => owner.kill()), exited]),
              killMs,
              'Video oracle forced shutdown could not confirm termination within its deadline'
            )
          }
          report('confirmed', { method, ...exit })
        } catch (error) {
          report('failed', { error: error.name, ...(exit && { exit }) })
          throw error
        }
      })())
    }
  }
}
