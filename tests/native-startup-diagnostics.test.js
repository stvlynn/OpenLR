import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findMacCrashReport, inspectNativeStartup } from '../scripts/native-startup-diagnostics.mjs'
import { withNativeWorkspace } from '../scripts/native-workspace.mjs'

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

test('native workspace records an unexpected runtime exit before cleanup and preserves the command failure', async (t) => {
  const logs = []
  t.mock.method(console, 'error', (line) => logs.push(line))
  const program = `
    const { createServer } = require('node:http')
    const { writeFileSync } = require('node:fs')
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const { command } = JSON.parse(body)
      if (command === 'photos') process.exit(23)
      if (command !== 'state') process.exit(24)
      response.end(JSON.stringify({ ok: true, result: { photos: [] } }))
    })
    server.listen(0, '127.0.0.1', () => {
      writeFileSync(process.env.OPENLR_AGENT_FILE, JSON.stringify({
        version: 1, pid: process.pid, token: 'private-runtime-fixture-token',
        url: 'http://127.0.0.1:' + server.address().port
      }))
    })
  `
  let original
  await assert.rejects(
    () =>
      withNativeWorkspace(
        process.execPath,
        async ({ call, initial }) => {
          assert.deepEqual(initial.photos, [])
          try {
            await call('photos')
          } catch (error) {
            original = error
            throw error
          }
        },
        { prepare: () => ['-e', program] }
      ),
    (error) => error === original && /Cannot reach the live OpenLR GUI agent/.test(error.message)
  )
  const prefix = 'Native workflow failure diagnostics: '
  const output = logs.filter((line) => line.startsWith(prefix))
  assert.equal(output.length, 1)
  assert.doesNotMatch(output[0], /private-runtime-fixture-token|agent\.json/)
  const report = JSON.parse(output[0].slice(prefix.length))
  assert.equal(report.host.exitCode, 23)
  assert.equal(report.host.signal, null)
  assert.equal(report.host.exitedBeforeCleanup, true)
  assert.ok(report.elapsedMs.exit >= report.elapsedMs.ready)
  assert.ok(report.elapsedMs.failure >= report.elapsedMs.ready)
  assert.deepEqual(report.session, { valid: true, matchesHost: true })
})

test('Mac crash collection matches recent PID and image and only emits bounded crash fields', async (t) => {
  const temporary = await realpath(tmpdir())
  const prefix = 'olr-crash-'
  const root = await mkdtemp(path.join(temporary, prefix))
  t.after(async () => {
    const cleanup = await realpath(root)
    assert.equal(path.dirname(cleanup), temporary)
    assert.ok(path.basename(cleanup).startsWith(prefix))
    await rm(cleanup, { recursive: true, force: true })
  })
  const startedWall = Date.now() - 1000
  const exitedWall = startedWall + 800
  const match = { pid: 123, executable: 'OpenLR', startedWall, exitedWall }
  const appleDate = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '0 +0000')
  const report = {
    pid: 123,
    procName: 'OpenLR',
    procLaunch: appleDate(startedWall + 30),
    captureTime: appleDate(exitedWall),
    procPath: '/Users/private-person/OpenLR.app/Contents/MacOS/OpenLR',
    asi: { native: ['private command payload'] },
    exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', codes: 'private exception' },
    termination: { namespace: 'SIGNAL', code: 11, indicator: 'private cause' },
    faultingThread: 0,
    threads: [
      {
        frames: [
          { imageIndex: 0, symbol: '-[WKWebView release]', imageOffset: 12, sourceFile: 'private.m' },
          { imageIndex: 1, symbol: '/Users/private-person/private', imageOffset: 34 },
          ...Array.from({ length: 7 }, () => ({ imageIndex: 0, imageOffset: 56 }))
        ]
      }
    ],
    usedImages: [
      { name: 'WebKit', path: '/System/Library/Frameworks/WebKit.framework/WebKit' },
      { name: '/Users/private-person/extra', path: '/Users/private-person/extra' }
    ]
  }
  const write = (name, changes, bug = '309') =>
    writeFile(
      path.join(root, name),
      JSON.stringify({ bug_type: bug }) + '\n' + JSON.stringify({ ...report, ...changes })
    )
  await Promise.all([
    write('OpenLR-3.ips', { pid: 321 }),
    write('OpenLR-2.ips', { captureTime: appleDate(startedWall - 60_000) }),
    write('OpenLR-1.ips', {}, '999'),
    write('Other-1.ips', {}),
    write('OpenLR-0.ips', { isNonFatal: true })
  ])
  const options = { directories: [root], timeoutMs: 0 }
  assert.deepEqual(await findMacCrashReport(match, options), { status: 'no-match' })
  await write('OpenLR-4.ips', {})
  const result = JSON.parse(JSON.stringify(await findMacCrashReport(match, options)))
  assert.equal(result.status, 'matched')
  assert.deepEqual(result.exception, { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV' })
  assert.deepEqual(result.termination, { namespace: 'SIGNAL', code: 11 })
  assert.equal(result.frames.length, 6)
  assert.deepEqual(result.frames[0], { image: 'WebKit', symbol: '-[WKWebView release]', imageOffset: 12 })
  assert.deepEqual(result.frames[1], { imageOffset: 34 })
  assert.doesNotMatch(JSON.stringify(result), /private|Users|Library/)
})
