import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspectNativeStartup } from '../scripts/native-startup-diagnostics.mjs'

async function fixture(t, respond) {
  const root = await mkdtemp(path.join(tmpdir(), 'openlr-startup-probe-'))
  const session = path.join(root, 'agent.json')
  const token = 'private-test-token'
  const requests = []
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ' + token)
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url, body: body ? JSON.parse(body) : null })
    respond(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    assert.ok(path.basename(root).startsWith('openlr-startup-probe-'))
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(
    session,
    JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${server.address().port}`,
      token,
      pid: 123
    })
  )
  const inspect = (options = {}) =>
    inspectNativeStartup({
      session,
      host: { pid: 123, exitCode: null, signalCode: null },
      startedAt: performance.now() - 100,
      sessionAt: performance.now() - 50,
      requestAt: performance.now() - 30,
      ...options
    })
  return { inspect, requests, token, session }
}

test('startup diagnostics probe broker, control and UI without replaying state or exposing payloads', async (t) => {
  const { inspect, requests, token } = await fixture(t, (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify(
        request.url === '/health'
          ? { ok: true, version: 1 }
          : request.url === '/diagnostics/startup-ui'
            ? { responded: true, data: 'private-probe-data' }
            : { ok: true, result: { filename: 'private-photo.jpg', token: 'private-test-token' } }
      )
    )
  })
  const result = await inspect()
  assert.deepEqual(result.session, { valid: true, matchesHost: true })
  assert.deepEqual(result.host, { pid: 123, exitCode: null, signal: null })
  assert.deepEqual(result.health, { status: 200, ok: true, protocolV1: true })
  assert.deepEqual(result.control, { replied: true, active: true })
  assert.deepEqual(result.uiPump, { status: 200, responded: true, elapsedMs: result.uiPump.elapsedMs })
  assert.ok(result.uiPump.elapsedMs >= 0)
  assert.ok(result.elapsedMs.failure >= result.elapsedMs.request)
  assert.ok(result.elapsedMs.request >= result.elapsedMs.session)
  assert.deepEqual(requests.map((request) => request.path).sort(), [
    '/command',
    '/diagnostics/startup-ui',
    '/health'
  ])
  assert.deepEqual(requests.find((request) => request.body).body, {
    command: 'export-status',
    args: {},
    capture: false
  })
  assert.equal(JSON.stringify(result).includes(token), false)
  assert.equal(JSON.stringify(result).includes('private-photo'), false)
  assert.equal(JSON.stringify(result).includes('private-probe-data'), false)
})

test('startup diagnostics retain working health when the separate control path stalls', async (t) => {
  const { inspect, requests } = await fixture(t, (request, response) => {
    if (request.url === '/health') response.end(JSON.stringify({ ok: true, version: 1 }))
    if (request.url === '/diagnostics/startup-ui') response.end(JSON.stringify({ responded: false }))
  })
  const result = await inspect({ timeoutMs: 1000 })
  assert.equal(result.health.ok, true)
  assert.equal(result.control.error, 'Error')
  assert.equal(result.uiPump.responded, false)
  assert.equal(requests.filter((request) => request.body?.command === 'export-status').length, 1)
  assert.equal(requests.filter((request) => request.path === '/diagnostics/startup-ui').length, 1)
  assert.equal(
    requests.some((request) => request.body?.command === 'state'),
    false
  )
})

test('startup diagnostics distinguish an unavailable UI probe endpoint from a nonresponding UI', async (t) => {
  const { inspect } = await fixture(t, (request, response) => {
    if (request.url === '/diagnostics/startup-ui') {
      response.writeHead(404).end('private error details')
    } else {
      response.end(JSON.stringify({ ok: true, version: 1, result: null }))
    }
  })
  const result = await inspect()
  assert.deepEqual(result.uiPump, { status: 404 })
  assert.equal(result.health.ok, true)
  assert.equal(result.control.replied, true)
})

test('startup diagnostics reject invalid sessions without sending a probe or leaking the path', async (t) => {
  const { inspect, requests, session } = await fixture(t, () => assert.fail('Unexpected request'))
  await writeFile(session, JSON.stringify({ version: 1, url: 'https://example.invalid', token: 'secret' }))
  const result = await inspect()
  assert.deepEqual(result.session, { valid: false, error: 'Error' })
  assert.deepEqual(requests, [])
  assert.equal(Object.hasOwn(result, 'health'), false)
  assert.equal(JSON.stringify(result).includes(session), false)
})

test('startup diagnostics do not probe a descriptor owned by another process', async (t) => {
  const { inspect, requests } = await fixture(t, () => assert.fail('Unexpected request'))
  const result = await inspect({ host: { pid: 456, exitCode: null, signalCode: null } })
  assert.deepEqual(result.session, { valid: true, matchesHost: false })
  assert.deepEqual(requests, [])
  assert.equal(Object.hasOwn(result, 'health'), false)
})
