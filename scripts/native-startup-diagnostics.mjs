import { readFile } from 'node:fs/promises'
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
