import assert from 'node:assert/strict'

function within(operation, milliseconds, message) {
  let timer
  return Promise.race([
    operation,
    new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(message()), { code: 'VIDEO_ORACLE_DEADLINE' })),
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
  let exit,
    processClosed = false,
    serverClosed = false
  const operations = {}
  const snapshot = (operation) => ({
    operation,
    processExited: Boolean(exit),
    processClosed,
    serverClosed,
    operationStatus: operations[operation] ?? 'not-started',
    pendingOperations: Object.keys(operations).filter((name) => operations[name] === 'pending')
  })
  const deadlineMessage = (operation) =>
    `Video oracle ${operation === 'kill' ? 'forced' : 'graceful'} shutdown exceeded its deadline: ` +
    (exit
      ? 'browser process exited; shutdown cleanup remains unfinished'
      : 'browser process termination is unconfirmed')
  const runOperation = (operation, run) => {
    operations[operation] = 'pending'
    return Promise.resolve()
      .then(run)
      .then(
        (value) => {
          operations[operation] = 'fulfilled'
          report('operation-settled', { operation, status: 'fulfilled' })
          return value
        },
        (error) => {
          operations[operation] = 'rejected'
          report('operation-settled', { operation, status: 'rejected', error: error.name })
          throw error
        }
      )
  }
  child.once('close', (code, signal) => {
    processClosed = true
    report('process-closed', { code, signal })
  })
  owner.once('close', () => {
    serverClosed = true
    report('server-closed')
  })
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
        let operation = 'close'
        try {
          let method = 'graceful'
          try {
            await within(Promise.all([runOperation('close', () => owner.close()), exited]), closeMs, () =>
              deadlineMessage('close')
            )
          } catch (error) {
            report(
              error.code === 'VIDEO_ORACLE_DEADLINE' ? 'close-deadline' : 'close-failed',
              snapshot('close')
            )
            report('kill-requested')
            method = 'killed'
            operation = 'kill'
            try {
              await within(Promise.all([runOperation('kill', () => owner.kill()), exited]), killMs, () =>
                deadlineMessage('kill')
              )
            } catch (error) {
              if (error.code === 'VIDEO_ORACLE_DEADLINE') report('kill-deadline', snapshot('kill'))
              throw error
            }
          }
          report('confirmed', { method, ...exit })
        } catch (error) {
          report('failed', { error: error.name, ...snapshot(operation), ...(exit && { exit }) })
          throw error
        }
      })())
    }
  }
}
