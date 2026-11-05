import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execute, parse } from '../cli/openlr.mjs'
import { inspectNativeStartup } from './native-startup-diagnostics.mjs'

// Isolated native test lifecycle, shared by workflows that need their own GUI.
export async function withNativeWorkspace(
  executable,
  workflow,
  { persistent = false, env: extraEnv = {} } = {}
) {
  if (!executable) throw Error('Pass the path to a built OpenLR executable')
  const temp = await realpath(tmpdir()),
    prefix = 'olr-w-'
  const root = await mkdtemp(path.join(temp, prefix))
  const session = path.join(root, 'agent.json')
  const call = (...args) => execute(parse([...args, '--session', session, '--timeout', '30']))
  let host, exited
  async function start() {
    const startedAt = performance.now()
    let launchError, sessionAt, requestAt
    // MyGo falls back to a shared single-instance socket when its runtime path is too long.
    const socket = path.join(root, `mygo-${process.getuid?.() ?? -1}-000000000000.sock`)
    assert.ok(
      Buffer.byteLength(socket) < 100,
      'Use a shorter temporary directory for the private MyGo socket'
    )
    const env = {
      ...process.env,
      ...extraEnv,
      OPENLR_EPHEMERAL: persistent ? '0' : '1',
      OPENLR_AGENT_FILE: session,
      OPENLR_LOCAL_FILE: path.join(root, 'folders.json'),
      OPENLR_EXTERNAL_FILE: path.join(root, 'external.json'),
      OPENLR_SHARE_FILE: path.join(root, 'sharing.json'),
      OPENLR_CAMERA_DIRECTORY: path.join(root, 'captures'),
      WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview2'),
      APPDATA: root,
      LOCALAPPDATA: root,
      XDG_CONFIG_HOME: root,
      XDG_DATA_HOME: root,
      XDG_CACHE_HOME: root,
      XDG_RUNTIME_DIR: root
    }
    // Keep connecting to the existing compositor when the original socket name was relative.
    const { WAYLAND_DISPLAY: display, XDG_RUNTIME_DIR: runtime } = process.env
    if (process.platform === 'linux' && runtime && display && !path.isAbsolute(display))
      env.WAYLAND_DISPLAY = path.join(runtime, display)
    host = spawn(path.resolve(executable), [], { env, stdio: 'inherit' })
    host.once('error', (error) => {
      launchError = error
    })
    exited = new Promise((resolve) => host.once('close', resolve))
    try {
      const deadline = Date.now() + 45000
      for (;;) {
        if (launchError) throw launchError
        if (host.exitCode !== null || host.signalCode) throw Error('Host exited before agent connected')
        try {
          await access(session)
          break
        } catch {}
        if (Date.now() > deadline) throw Error('No agent session after 45 seconds')
        await delay(120)
      }
      sessionAt = requestAt = performance.now()
      return await call('state')
    } catch (error) {
      try {
        const diagnostic = await inspectNativeStartup({ session, host, startedAt, sessionAt, requestAt })
        console.error('Native startup diagnostics: ' + JSON.stringify(diagnostic))
      } catch {
        console.error('Native startup diagnostics unavailable')
      }
      throw error
    }
  }
  async function stop() {
    if (!host) return
    host.kill()
    await Promise.race([
      exited,
      delay(5000, undefined, { ref: false }).then(() => {
        throw Error('Host did not exit')
      })
    ])
    host = null
    await rm(session, { force: true })
  }

  let primaryFailure = false
  try {
    const initial = await start()
    return await workflow({
      root,
      session,
      call,
      initial,
      profile: path.join(root, 'webview2'),
      restart: async () => {
        await stop()
        return start()
      }
    })
  } catch (error) {
    primaryFailure = true
    throw error
  } finally {
    const cleanupFailures = []
    try {
      await stop()
    } catch (error) {
      cleanupFailures.push(error)
    }
    try {
      const cleanup = await realpath(root)
      assert.equal(path.dirname(cleanup), temp)
      assert.ok(path.basename(cleanup).startsWith(prefix))
      await rm(cleanup, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
    } catch (error) {
      cleanupFailures.push(error)
    }
    if (cleanupFailures.length) {
      if (!primaryFailure) throw new AggregateError(cleanupFailures, 'Native workspace cleanup failed')
      console.error(
        'Native workspace cleanup failed',
        cleanupFailures.map(({ code, name }) => code ?? name)
      )
    }
  }
}
