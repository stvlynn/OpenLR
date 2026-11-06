import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import timers from 'node:timers/promises'
import { withNativeWorkspace } from '../scripts/native-workspace.mjs'

function controlledHost(t, closes, { secondaryCloses = true } = {}) {
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
        host.exitCode = 0
        host.emit('close', 0, null)
      }
      return true
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
  const { root } = await run((workspace) => workspace)
  assert.equal(stopCalls(), 1)
  await assert.rejects(access(root), { code: 'ENOENT' })
  assert.deepEqual(errors, [])
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
  await assert.rejects(
    run(async (value) => {
      workspace = value
      await assert.rejects(workspace.stop(), /Host did not exit/)
      await assert.rejects(workspace.start(), /exit is unconfirmed/)
      assert.equal(spawnCalls(), 1)
    }),
    (error) =>
      error instanceof AggregateError &&
      error.message === 'Native workspace cleanup failed' &&
      error.errors[0]?.message === 'Host did not exit'
  )
  assert.equal(stopCalls(), 2)
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
