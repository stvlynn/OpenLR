import { open, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { connect, execute } from '../cli/openlr.mjs'

const failure = (error) => ({
  error: error.name,
  ...(typeof error.code === 'string' ? { code: error.code } : {})
})

// Failure-only, read-only probes. Never retry the failed command or serialize
// the descriptor, credentials, command payloads, or returned workspace data.
export async function inspectNativeStartup({
  session,
  host,
  startedAt,
  sessionAt,
  requestAt,
  timeoutMs = 2000
}) {
  const elapsed = (time) => (time === undefined ? null : Math.round(time - startedAt))
  const result = {
    elapsedMs: {
      session: elapsed(sessionAt),
      request: elapsed(requestAt),
      failure: elapsed(performance.now())
    },
    host: { pid: host.pid ?? null, exitCode: host.exitCode, signal: host.signalCode }
  }
  let connection
  try {
    connection = await connect(session)
    const descriptor = JSON.parse(await readFile(session, 'utf8'))
    result.session = {
      valid: true,
      matchesHost: Number.isSafeInteger(host.pid) && host.pid > 0 && descriptor.pid === host.pid
    }
    if (!result.session.matchesHost) return result
  } catch (error) {
    result.session = { valid: false, ...failure(error) }
    return result
  }
  const get = (endpoint) =>
    fetch(new URL(endpoint, connection.url), {
      headers: { Authorization: 'Bearer ' + connection.token },
      signal: AbortSignal.timeout(timeoutMs)
    })
  const [health, control, uiPump] = await Promise.allSettled([
    (async () => {
      const response = await get('/health')
      const body = await response.json()
      return { status: response.status, ok: response.ok && body.ok === true, protocolV1: body.version === 1 }
    })(),
    execute({ command: 'export-status', args: {}, session, timeout: timeoutMs / 1000 }).then((value) => ({
      replied: true,
      active: value !== null
    })),
    (async () => {
      const started = performance.now()
      const response = await get('/diagnostics/startup-ui')
      if (!response.ok) return { status: response.status }
      const body = await response.json()
      return {
        status: response.status,
        responded: typeof body?.responded === 'boolean' ? body.responded : null,
        elapsedMs: Math.round(performance.now() - started)
      }
    })()
  ])
  result.health = health.status === 'fulfilled' ? health.value : failure(health.reason)
  result.control = control.status === 'fulfilled' ? control.value : failure(control.reason)
  result.uiPump = uiPump.status === 'fulfilled' ? uiPump.value : failure(uiPump.reason)
  return result
}

function identifier(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : undefined
}

function summarizeMacCrash(contents, { pid, executable, startedWall, exitedWall }) {
  const firstLine = contents.indexOf('\n')
  if (firstLine < 0) return
  let report
  try {
    if (String(JSON.parse(contents.slice(0, firstLine))?.bug_type) !== '309') return
    report = JSON.parse(contents.slice(firstLine + 1))
  } catch {
    return
  }
  if (
    report?.pid !== pid ||
    report.procName !== executable ||
    [true, 'true'].includes(report.isNonFatal) ||
    [true, 'true'].includes(report.isSimulated)
  )
    return
  const captured = Date.parse(report.captureTime),
    launched = Date.parse(report.procLaunch)
  if (
    !Number.isFinite(captured) ||
    captured < startedWall - 1000 ||
    captured > exitedWall + 2000 ||
    (Number.isFinite(launched) && (launched < startedWall - 1000 || launched > captured))
  )
    return
  const frames = report.threads?.[report.faultingThread]?.frames
  return {
    status: 'matched',
    exception: {
      type: identifier(report.exception?.type, /^EXC_[A-Z0-9_]{1,48}$/),
      signal: identifier(report.exception?.signal, /^SIG[A-Z0-9]{1,18}$/)
    },
    termination: {
      namespace: identifier(report.termination?.namespace, /^[A-Z][A-Z0-9_ -]{0,40}$/),
      code: Number.isSafeInteger(report.termination?.code) ? report.termination.code : undefined
    },
    frames: Array.isArray(frames)
      ? frames.slice(0, 6).map((frame) => ({
          image: identifier(report.usedImages?.[frame?.imageIndex]?.name, /^[A-Za-z0-9_.+ -]{1,80}$/),
          symbol: identifier(frame?.symbol, /^[A-Za-z0-9_.$:<>,()[\] +\-~*&!]{1,128}$/),
          imageOffset: Number.isSafeInteger(frame?.imageOffset) ? frame.imageOffset : undefined
        }))
      : []
  }
}

// Collect a small, allowlisted summary of a report for our own exited child.
// The original report can contain paths, process arguments and diagnostic text.
export async function findMacCrashReport(
  match,
  {
    directories = [path.join(homedir(), 'Library/Logs/DiagnosticReports'), '/Library/Logs/DiagnosticReports'],
    timeoutMs = 2000
  } = {}
) {
  const deadline = performance.now() + timeoutMs,
    maxBytes = 2 * 1024 * 1024,
    inspected = new Map()
  let available = false
  do {
    for (const directory of directories) {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => null)
      if (!entries) continue
      available = true
      const files = entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith('.ips') &&
            (entry.name.startsWith(match.executable + '-') || entry.name.startsWith(match.executable + '_'))
        )
        .map(({ name }) => name)
        .sort()
        .reverse()
        .slice(0, 6)
      for (const name of files) {
        const filename = path.join(directory, name)
        const file = await open(filename, 'r').catch(() => null)
        if (!file) continue
        try {
          const { mtimeMs, size } = await file.stat()
          if (mtimeMs < match.startedWall - 1000 || size < 1 || size > maxBytes) continue
          const version = `${mtimeMs}:${size}`
          if (inspected.get(filename) === version) continue
          inspected.set(filename, version)
          const buffer = Buffer.alloc(size)
          const { bytesRead } = await file.read(buffer, 0, size, 0)
          const report = summarizeMacCrash(buffer.toString('utf8', 0, bytesRead), match)
          if (report) return report
        } catch {
          // The system may still be writing or moving a candidate.
        } finally {
          await file.close().catch(() => {})
        }
      }
    }
    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    await delay(Math.min(150, remaining))
  } while (performance.now() < deadline)
  return { status: available ? 'no-match' : 'unavailable' }
}

export async function inspectNativeRuntime({ session, host, lifecycle }) {
  const failureAt = performance.now()
  const [probe] = await Promise.all([
    inspectNativeStartup({ session, host, startedAt: lifecycle.startedAt }),
    lifecycle.exit ? undefined : Promise.race([lifecycle.exitEvent, delay(250, undefined, { ref: false })])
  ])
  const { exit, readyAt, startedAt, startedWall } = lifecycle
  const result = {
    ...probe,
    elapsedMs: {
      ready: Math.round(readyAt - startedAt),
      failure: Math.round(failureAt - startedAt),
      exit: exit ? Math.round(exit.at - startedAt) : null
    },
    host: {
      pid: host.pid ?? null,
      exitCode: exit?.code ?? host.exitCode,
      signal: exit?.signal ?? host.signalCode,
      exitedBeforeCleanup: Boolean(exit)
    }
  }
  if (process.platform === 'darwin' && exit && Number.isSafeInteger(host.pid)) {
    result.macCrash = await findMacCrashReport({
      pid: host.pid,
      executable: path.basename(host.spawnfile),
      startedWall,
      exitedWall: exit.wall
    })
  }
  return result
}
