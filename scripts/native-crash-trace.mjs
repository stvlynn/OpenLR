import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const prefix = 'OpenLR host LLDB '
const script = fileURLToPath(new URL('./fixtures/host_trace.py', import.meta.url))
const stopPhases = new Set([
  'attach-failed',
  'resume-failed',
  'fault',
  'kill-failed',
  'unexpected-stop',
  'inferior-exited',
  'detached',
  'detach-failed',
  'trace-deadline'
])

function launchDebugger(pid, finished) {
  return spawn(
    'xcrun',
    [
      'lldb',
      '--batch',
      '--no-lldbinit',
      '-o',
      'command script import ' + JSON.stringify(script),
      '-o',
      `openlr-trace-host ${pid} ${JSON.stringify(finished)} 190`
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
}

function traceRecord(line, pid) {
  if (!line.startsWith(prefix)) return
  try {
    const record = JSON.parse(line.slice(prefix.length))
    if (
      record.pid === pid &&
      (record.phase === 'attach-started' || record.phase === 'running' || stopPhases.has(record.phase))
    )
      return record
  } catch {}
}

// The caller supplies its owned host PID and the operation to observe.
// Attach and resume before submitting that operation; detach before returning.
export async function withHostCrashTrace(
  { root, pid },
  run,
  { launch = launchDebugger, log = console.log, attachMs = 25_000, closeMs = 5_000 } = {}
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Host trace requires an owned host PID')
  const finished = path.join(root, 'host-trace-finished')
  const startedAt = performance.now()
  const report = (record) =>
    log(prefix + JSON.stringify({ ...record, elapsedMs: Math.round(performance.now() - startedAt) }))
  report({ pid, phase: 'debugger-launch', attachBudgetMs: attachMs })
  const child = launch(pid, finished)
  let terminal, launchError, ready
  const started = new Promise((resolve) => (ready = resolve))
  child.once('error', (error) => (launchError = error.code || error.name))
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
  createInterface({ input: child.stdout }).on('line', (line) => {
    const record = traceRecord(line, pid)
    if (!record) return
    report(record)
    if (record.phase === 'running') ready('running')
    if (stopPhases.has(record.phase)) terminal = record.phase
  })

  let failed = false
  try {
    const attachment = await Promise.race([
      started,
      closed.then(() => 'closed'),
      delay(attachMs, 'deadline', { ref: false })
    ])
    if (attachment === 'deadline') {
      report({ pid, phase: 'attach-deadline' })
      throw Error('LLDB did not report a running host within the diagnostic attach budget')
    }
    if (attachment !== 'running')
      throw Error('LLDB could not attach and resume the host' + (launchError ? ` (${launchError})` : ''))
    return await run()
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      await writeFile(finished, '')
      const exit = await Promise.race([closed, delay(closeMs, null, { ref: false })])
      if (!exit) {
        child.kill('SIGKILL')
        if (!(await Promise.race([closed, delay(closeMs, null, { ref: false })])))
          throw Error('Host debugger did not exit')
        throw Error('Host debugger did not detach in time')
      }
      if (!failed && (terminal !== 'detached' || exit.code !== 0))
        throw Error('Host debugger ended without a clean detach')
    } catch (error) {
      if (!failed) throw error
      log('OpenLR host LLDB cleanup failed')
    }
  }
}
