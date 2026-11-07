import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import timers from 'node:timers/promises'
import { withNativeWorkspace } from '../scripts/native-workspace.mjs'

function realHost(t, { stopSignal } = {}) {
  const spawn = childProcess.spawn
  const children = []
  t.mock.method(childProcess, 'spawn', (...args) => {
    const child = spawn(...args)
    children.push({ child, closed: once(child, 'close') })
    return child
  })
  syncBuiltinESMExports()
  t.after(async () => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await closed
    }
  })
  const program = `
    const { createServer } = require('node:http')
    const { writeFileSync } = require('node:fs')
    const stopSignal = ${JSON.stringify(stopSignal)}
    if (stopSignal) process.on('SIGTERM', () => process.kill(process.pid, stopSignal))
    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== 'Bearer private-workspace-fixture') {
        response.writeHead(401).end()
        return
      }
      if (request.url === '/exit') {
        response.on('finish', () => process.exit(23))
        response.end('exiting')
        return
      }
      let body = ''
      for await (const chunk of request) body += chunk
      const { command } = JSON.parse(body)
      if (command !== 'state') process.exit(24)
      response.end(JSON.stringify({ ok: true, result: { photos: [] } }))
    })
    server.listen(0, '127.0.0.1', () => {
      writeFileSync(process.env.OPENLR_AGENT_FILE, JSON.stringify({
        version: 1, pid: process.pid, token: 'private-workspace-fixture',
        url: 'http://127.0.0.1:' + server.address().port
      }))
    })
  `
  return {
    children,
    async prepare({ root }) {
      const script = path.join(root, 'host.cjs')
      await writeFile(script, program)
      return [script]
    },
    async exit({ session }) {
      const { url, token } = JSON.parse(await readFile(session, 'utf8'))
      const response = await fetch(new URL('/exit', url), {
        headers: { Authorization: 'Bearer ' + token }
      })
      assert.equal(await response.text(), 'exiting')
      const [code, signal] = await children.at(-1).closed
      assert.deepEqual({ code, signal }, { code: 23, signal: null })
    }
  }
}

test('native workspace rejects a real host exit after the final assertion and still confirms cleanup', async (t) => {
  const host = realHost(t)
  let root,
    cleanupCalls = 0
  await assert.rejects(
    withNativeWorkspace(
      process.execPath,
      async (workspace) => {
        root = workspace.root
        assert.deepEqual(workspace.initial, { photos: [] })
        await host.exit(workspace)
        return 'workflow assertions completed'
      },
      { prepare: host.prepare, onCleanup: () => cleanupCalls++ }
    ),
    (error) =>
      error instanceof AggregateError &&
      error.errors.some((failure) => /Host exited before stop was requested.*23/.test(failure.message))
  )
  assert.equal(cleanupCalls, 1)
  await assert.rejects(access(root), { code: 'ENOENT' })
})

test('native workspace accepts requested termination of its real host', async (t) => {
  const host = realHost(t)
  let cleanupCalls = 0
  const root = await withNativeWorkspace(
    process.execPath,
    ({ root, initial }) => {
      assert.deepEqual(initial, { photos: [] })
      return root
    },
    { prepare: host.prepare, onCleanup: () => cleanupCalls++ }
  )
  assert.deepEqual(await host.children[0].closed, [null, 'SIGTERM'])
  assert.equal(cleanupCalls, 1)
  await assert.rejects(access(root), { code: 'ENOENT' })
})

test('native workspace preserves a primary failure after its real host has exited', async (t) => {
  const host = realHost(t)
  const primary = Error('Primary workflow assertion failed')
  const logs = []
  t.mock.method(console, 'error', (...parts) => logs.push(parts))
  let root,
    cleanupCalls = 0
  await assert.rejects(
    withNativeWorkspace(
      process.execPath,
      async (workspace) => {
        root = workspace.root
        await host.exit(workspace)
        throw primary
      },
      { prepare: host.prepare, onCleanup: () => cleanupCalls++ }
    ),
    (error) => error === primary
  )
  assert.equal(cleanupCalls, 1)
  await assert.rejects(access(root), { code: 'ENOENT' })
  assert.ok(logs.some(([message]) => message === 'Native workspace cleanup failed'))
})

test('native workspace stops a real host before starting its replacement on the same profile', async (t) => {
  const host = realHost(t)
  let root
  await withNativeWorkspace(
    process.execPath,
    async (workspace) => {
      root = workspace.root
      const marker = path.join(root, 'profile-marker')
      await writeFile(marker, 'same profile')
      await workspace.stop()
      assert.deepEqual(await host.children[0].closed, [null, 'SIGTERM'])
      await assert.rejects(access(workspace.session), { code: 'ENOENT' })
      assert.deepEqual(await workspace.start([path.join(root, 'host.cjs')]), { photos: [] })
      assert.equal(await readFile(marker, 'utf8'), 'same profile')
      assert.notEqual(host.children[0].child.pid, host.children[1].child.pid)
    },
    { prepare: host.prepare }
  )
  assert.equal(host.children.length, 2)
  assert.deepEqual(await host.children[1].closed, [null, 'SIGTERM'])
  await assert.rejects(access(root), { code: 'ENOENT' })
})

test(
  'native workspace rejects an unmatched terminal signal from its real host',
  { skip: process.platform === 'win32' && 'Windows does not deliver catchable SIGTERM to Node hosts' },
  async (t) => {
    const host = realHost(t, { stopSignal: 'SIGINT' })
    let root,
      cleanupCalls = 0
    await assert.rejects(
      withNativeWorkspace(
        process.execPath,
        (workspace) => {
          root = workspace.root
        },
        { prepare: host.prepare, onCleanup: () => cleanupCalls++ }
      ),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((failure) => /Host exited unexpectedly during stop.*SIGINT/.test(failure.message))
    )
    assert.deepEqual(await host.children[0].closed, [null, 'SIGINT'])
    assert.equal(cleanupCalls, 1)
    await assert.rejects(access(root), { code: 'ENOENT' })
  }
)

function controlledHost(
  t,
  closes,
  { secondaryCloses = true, signalSent = true, terminal = { code: 0, signal: null } } = {}
) {
  const errors = []
  const profileData = 'private test profile'
  const token = 'workspace-test-token'
  let tempRoot,
    stopCalls = 0,
    spawnCalls = 0,
    secondaryStopCalls = 0
  t.mock.method(childProcess, 'spawn', (executable, args, { env, cwd }) => {
    assert.equal(executable, process.execPath)
    if (path.basename(env.OPENLR_AGENT_FILE) === 'secondary-agent.json') {
      assert.equal(env.XDG_RUNTIME_DIR, tempRoot)
      assert.equal(env.WEBVIEW2_USER_DATA_FOLDER, path.join(tempRoot, 'secondary-webview2'))
      assert.equal(cwd, tempRoot)
      assert.deepEqual(args, ['relative.png'])
      const secondary = Object.assign(new EventEmitter(), { pid: 2345 })
      secondary.kill = () => {
        secondaryStopCalls++
        if (secondaryCloses) secondary.emit('close', 0, null)
        return true
      }
      return secondary
    }
    assert.deepEqual(args, [])
    tempRoot = env.XDG_RUNTIME_DIR
    assert.equal(path.dirname(env.OPENLR_AGENT_FILE), tempRoot)
    const host = Object.assign(new EventEmitter(), {
      pid: 1234 + spawnCalls++,
      exitCode: null,
      signalCode: null
    })
    host.kill = () => {
      stopCalls++
      if (closes) {
        host.exitCode = terminal.code
        host.signalCode = terminal.signal
        host.emit('close', terminal.code, terminal.signal)
      }
      return signalSent
    }
    writeFileSync(
      env.OPENLR_AGENT_FILE,
      JSON.stringify({ url: 'http://127.0.0.1:1', token, version: 1, pid: host.pid })
    )
    return host
  })
  t.mock.method(timers, 'setTimeout', async (ms, value, options) => {
    assert.equal(ms, 5000)
    assert.deepEqual(options, { ref: false })
    return value
  })
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url.href, 'http://127.0.0.1:1/command')
    assert.equal(request.headers.Authorization, 'Bearer ' + token)
    assert.deepEqual(JSON.parse(request.body), { command: 'state', args: {}, capture: false })
    return Response.json({ ok: true, result: { photos: [] } })
  })
  t.mock.method(console, 'error', (...parts) => errors.push(parts))
  syncBuiltinESMExports()
  t.after(async () => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    if (!tempRoot) return
    const cleanup = await realpath(tempRoot).catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!cleanup) return
    assert.equal(path.dirname(cleanup), await realpath(tmpdir()))
    assert.ok(path.basename(cleanup).startsWith('olr-w-'))
    await rm(cleanup, { recursive: true, force: true })
  })
  const run = (workflow, options) =>
    withNativeWorkspace(
      process.execPath,
      async ({ root, initial, profile, session, pid, start, stop, restart, launchSecondary }) => {
        assert.deepEqual(initial, { photos: [] })
        const marker = path.join(profile, 'catalog')
        await mkdir(profile)
        await writeFile(marker, profileData)
        return workflow({ root, marker, session, pid, start, stop, restart, launchSecondary })
      },
      options
    )
  return {
    run,
    errors,
    profileData,
    stopCalls: () => stopCalls,
    spawnCalls: () => spawnCalls,
    secondaryStopCalls: () => secondaryStopCalls
  }
}

test('native workspace removes its disposable profile after confirmed host close', async (t) => {
  const { run, errors, stopCalls } = controlledHost(t, true)
  let cleanupCalls = 0
  const { root } = await run((workspace) => workspace, { onCleanup: () => cleanupCalls++ })
  assert.equal(cleanupCalls, 1)
  assert.equal(stopCalls(), 1)
  await assert.rejects(access(root), { code: 'ENOENT' })
  assert.deepEqual(errors, [])
})

for (const [name, options, message] of [
  ['unsent termination signal', { signalSent: false }, /Host termination signal was not sent/],
  [
    'nonzero termination',
    { terminal: { code: 23, signal: null } },
    /Host exited unexpectedly during stop.*23/
  ],
  [
    'unmatched signal',
    { terminal: { code: null, signal: 'SIGINT' } },
    /Host exited unexpectedly during stop.*SIGINT/
  ]
]) {
  test(`native workspace rejects ${name} while confirming an observed close`, async (t) => {
    const { run } = controlledHost(t, true, options)
    let root,
      cleanupCalls = 0
    await assert.rejects(
      run(
        (workspace) => {
          root = workspace.root
        },
        { onCleanup: () => cleanupCalls++ }
      ),
      (error) =>
        error instanceof AggregateError && error.errors.some((failure) => message.test(failure.message))
    )
    assert.equal(cleanupCalls, 1)
    await assert.rejects(access(root), { code: 'ENOENT' })
  })
}

test('native workspace reports confirmed cleanup even when the workflow failed', async (t) => {
  const { run } = controlledHost(t, true)
  const failure = new Error('Media import failed')
  let root,
    cleaned = false
  await assert.rejects(
    run(
      (workspace) => {
        root = workspace.root
        throw failure
      },
      {
        onCleanup: async () => {
          await assert.rejects(access(root), { code: 'ENOENT' })
          cleaned = true
        }
      }
    ),
    (error) => error === failure
  )
  assert.equal(cleaned, true)
})

test('native workspace can stop and start the same profile without overlapping hosts', async (t) => {
  const { run, errors, profileData, stopCalls, spawnCalls } = controlledHost(t, true)
  const root = await run(async ({ root, marker, session, start, stop, restart }) => {
    await assert.rejects(start(), /already started/)
    assert.equal(spawnCalls(), 1)
    const initialSession = JSON.parse(await readFile(session, 'utf8'))

    await stop()
    await assert.rejects(access(session), { code: 'ENOENT' })
    assert.equal(await readFile(marker, 'utf8'), profileData)
    await stop()
    assert.equal(stopCalls(), 1)

    assert.deepEqual(await start(), { photos: [] })
    const secondSession = JSON.parse(await readFile(session, 'utf8'))
    assert.notEqual(secondSession.pid, initialSession.pid)
    assert.equal(await readFile(marker, 'utf8'), profileData)
    assert.deepEqual(await restart(), { photos: [] })
    assert.equal(spawnCalls(), 3)
    assert.equal(stopCalls(), 2)
    return root
  })
  await assert.rejects(access(root), { code: 'ENOENT' })
  assert.equal(stopCalls(), 3)
  assert.deepEqual(errors, [])
})

test('native workspace retains the profile and session after an unconfirmed close', async (t) => {
  const { run, errors, profileData, stopCalls, spawnCalls } = controlledHost(t, false)
  let workspace
  let cleanupCalls = 0
  await assert.rejects(
    run(
      async (value) => {
        workspace = value
        await assert.rejects(workspace.stop(), /Host did not exit/)
        await assert.rejects(workspace.start(), /exit is unconfirmed/)
        assert.equal(spawnCalls(), 1)
      },
      { onCleanup: () => cleanupCalls++ }
    ),
    (error) =>
      error instanceof AggregateError &&
      error.message === 'Native workspace cleanup failed' &&
      error.errors[0]?.message === 'Host did not exit'
  )
  assert.equal(stopCalls(), 2)
  assert.equal(cleanupCalls, 0)
  assert.equal(await readFile(workspace.marker, 'utf8'), profileData)
  await access(workspace.session)
  assert.deepEqual(errors, [
    ['Native workspace retained in the system temporary directory', path.basename(workspace.root)]
  ])
})

test('native workspace retains the profile and preserves a primary workflow failure', async (t) => {
  const { run, errors, profileData } = controlledHost(t, false)
  const failure = new Error('Primary workflow failure')
  let workspace
  await assert.rejects(
    run((value) => {
      workspace = value
      throw failure
    }),
    (error) => error === failure
  )
  assert.equal(await readFile(workspace.marker, 'utf8'), profileData)
  assert.match(JSON.stringify(errors), /Native workspace cleanup failed/)
})

test('native workspace retains its root and prevents another start when auxiliary closure is unconfirmed', async (t) => {
  const { run, errors, profileData, spawnCalls, secondaryStopCalls } = controlledHost(t, true, {
    secondaryCloses: false
  })
  let workspace
  await assert.rejects(
    run(async (value) => {
      workspace = value
      const { root, pid, stop, start, launchSecondary } = value
      const secondary = launchSecondary(['relative.png'], root)
      assert.notEqual(secondary.pid, pid)
      assert.throws(() => launchSecondary(['relative.png'], root), /exactly one/)
      await stop()
      await assert.rejects(start(), /exit is unconfirmed/)
    }),
    (error) =>
      error instanceof AggregateError &&
      error.message === 'Native workspace cleanup failed' &&
      error.errors[0]?.message === 'Host did not exit'
  )
  assert.equal(spawnCalls(), 1)
  assert.equal(secondaryStopCalls(), 1)
  assert.equal(await readFile(workspace.marker, 'utf8'), profileData)
  assert.deepEqual(errors, [
    ['Native workspace retained in the system temporary directory', path.basename(workspace.root)]
  ])
})

test('native workspace cleans its prepared files when pre-start setup fails', async (t) => {
  const { run, errors, spawnCalls } = controlledHost(t, true)
  const failure = new Error('Pre-start setup failed')
  let preparedRoot
  await assert.rejects(
    run(() => assert.fail('No workflow may run after a setup failure'), {
      async prepare({ root }) {
        preparedRoot = root
        await writeFile(path.join(root, 'fixture.png'), 'generated fixture')
        throw failure
      }
    }),
    (error) => error === failure
  )
  assert.equal(spawnCalls(), 0)
  await assert.rejects(access(preparedRoot), { code: 'ENOENT' })
  assert.deepEqual(errors, [])
})

test('a system launcher must identify the application and confirm its shutdown', async (t) => {
  const roots = []
  t.after(async () => {
    for (const root of roots) {
      assert.equal(path.dirname(root), await realpath(tmpdir()))
      assert.ok(path.basename(root).startsWith('olr-w-'))
      await rm(root, { recursive: true, force: true })
    }
  })
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, result: { photos: [] } }))
  t.mock.method(console, 'error', () => {})
  for (const [descriptorPid, closeCode] of [
    [7744, 0],
    [7745, 0],
    [7744, 2]
  ]) {
    let calls = 0
    const run = withNativeWorkspace(
      process.execPath,
      ({ pid }) => {
        assert.equal(pid, 7744)
        calls++
      },
      {
        launch({ env }) {
          roots.push(env.XDG_RUNTIME_DIR)
          const child = Object.assign(new EventEmitter(), { pid: 7700, exitCode: null, signalCode: null })
          writeFileSync(
            env.OPENLR_AGENT_FILE,
            JSON.stringify({
              url: 'http://127.0.0.1:1',
              token: 'private-test',
              version: 1,
              pid: descriptorPid
            })
          )
          return {
            child,
            ready: Promise.resolve(7744),
            stop() {
              child.emit('exit', closeCode, null)
              child.emit('close', closeCode, null)
            }
          }
        }
      }
    )
    if (descriptorPid !== 7744) await assert.rejects(run, /7745/)
    else if (closeCode === 2) await assert.rejects(run, /Native workspace cleanup failed/)
    else await run
    assert.equal(calls, descriptorPid === 7744 ? 1 : 0)
    if (closeCode === 2) await access(path.join(roots.at(-1), 'agent.json'))
    else await assert.rejects(access(roots.at(-1)), { code: 'ENOENT' })
  }
})
