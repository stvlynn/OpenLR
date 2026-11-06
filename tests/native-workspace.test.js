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

function controlledHost(t, closes) {
  const errors = []
  const profileData = 'private test profile'
  const token = 'workspace-test-token'
  let tempRoot,
    stopCalls = 0,
    spawnCalls = 0
  t.mock.method(childProcess, 'spawn', (executable, args, { env }) => {
    assert.equal(executable, process.execPath)
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
  const run = (workflow) =>
    withNativeWorkspace(
      process.execPath,
      async ({ root, initial, profile, session, start, stop, restart }) => {
        assert.deepEqual(initial, { photos: [] })
        const marker = path.join(profile, 'catalog')
        await mkdir(profile)
        await writeFile(marker, profileData)
        return workflow({ root, marker, session, start, stop, restart })
      }
    )
  return { run, errors, profileData, stopCalls: () => stopCalls, spawnCalls: () => spawnCalls }
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
