import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execute, parse } from '../cli/openlr.mjs'
import { inspectNativeRuntime, reportNativeStartupFailure } from './native-startup-diagnostics.mjs'

// Isolated native test lifecycle, shared by workflows that need their own GUI.
export async function withNativeWorkspace(
  executable,
  workflow,
  { persistent = false, env: extraEnv = {}, prepare, onCleanup, launch } = {}
) {
  if (!executable) throw Error('Pass the path to a built OpenLR executable')
  const temp = await realpath(tmpdir()),
    prefix = 'olr-w-'
  const root = await mkdtemp(path.join(temp, prefix))
  const session = path.join(root, 'agent.json')
  const call = (...args) => execute(parse([...args, '--session', session, '--timeout', '30']))
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

  let host, exited, lifecycle, ownedApplication, applicationPid, secondary, secondaryExited
  async function start(args = []) {
    if (host || secondary) throw Error('Native workspace host is already started or its exit is unconfirmed')
    const startedAt = performance.now()
    let launchError, sessionAt, requestAt
    // MyGo falls back to a shared single-instance socket when its runtime path is too long.
    const socket = path.join(root, `mygo-${process.getuid?.() ?? -1}-000000000000.sock`)
    assert.ok(
      Buffer.byteLength(socket) < 100,
      'Use a shorter temporary directory for the private MyGo socket'
    )
    ownedApplication = launch?.({ executable: path.resolve(executable), args, env })
    host = ownedApplication?.child ?? spawn(path.resolve(executable), args, { env, stdio: 'inherit' })
    const observed = (lifecycle = { startedAt, startedWall: Date.now() })
    observed.exitEvent = new Promise((resolve) =>
      host.once('exit', (code, signal) => {
        observed.exit = { code, signal, at: performance.now(), wall: Date.now() }
        resolve()
      })
    )
    host.once('error', (error) => {
      launchError = error
    })
    exited = new Promise((resolve) => host.once('close', (code, signal) => resolve({ code, signal })))
    try {
      const deadline = Date.now() + 45000
      applicationPid = ownedApplication ? await ownedApplication.ready : host.pid
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
      if (ownedApplication) assert.equal(JSON.parse(await readFile(session, 'utf8')).pid, applicationPid)
      sessionAt = requestAt = performance.now()
      const initial = await call('state')
      observed.readyAt = performance.now()
      return initial
    } catch (error) {
      if (!ownedApplication) await reportNativeStartupFailure({
        session,
        host,
        exited: observed.exitEvent,
        startedAt,
        sessionAt,
        requestAt,
        observeLateStartup: env.OPENLR_DIAGNOSTICS === '1'
      })
      throw error
    }
  }
  async function killAndWait(child, closed) {
    child.kill()
    await Promise.race([
      closed,
      delay(5000, undefined, { ref: false }).then(() => {
        throw Error('Host did not exit')
      })
    ])
  }
  async function stop() {
    if (!host) return
    lifecycle.stopRequested = true
    if (ownedApplication) {
      ownedApplication.stop()
      const result = await Promise.race([exited, delay(10_000, null, { ref: false })])
      assert.ok(result?.signal === null && [0, 1].includes(result.code), 'Application launcher could not confirm cleanup')
    } else await killAndWait(host, exited)
    try {
      await rm(session, { force: true })
    } finally {
      host = null
      ownedApplication = null
      lifecycle = null
    }
  }

  function launchSecondary(args, cwd, launcher = executable) {
    if (!host || secondary) throw Error('Expected exactly one running native workspace host')
    // Share the private instance socket. If forwarding fails and another
    // workspace starts, keep its renderer profile and agent descriptor separate.
    secondary = spawn(path.resolve(launcher), args, {
      cwd,
      env: {
        ...env,
        OPENLR_AGENT_FILE: path.join(root, 'secondary-agent.json'),
        WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'secondary-webview2')
      },
      stdio: 'inherit'
    })
    secondaryExited = new Promise((resolve) =>
      secondary.once('close', () => {
        secondary = null
        resolve()
      })
    )
    return secondary
  }

  let primaryFailure = false
  try {
    const initial = await start(await prepare?.({ root }))
    return await workflow({
      root,
      session,
      call,
      initial,
      profile: path.join(root, 'webview2'),
      pid: applicationPid,
      launchSecondary,
      start,
      stop,
      restart: async () => {
        await stop()
        return start()
      }
    })
  } catch (error) {
    primaryFailure = true
    if (!ownedApplication && lifecycle?.readyAt !== undefined && !lifecycle.stopRequested) {
      try {
        const diagnostic = await inspectNativeRuntime({ session, host, lifecycle })
        console.error('Native workflow failure diagnostics: ' + JSON.stringify(diagnostic))
      } catch {
        console.error('Native workflow failure diagnostics unavailable')
      }
    }
    throw error
  } finally {
    const cleanupFailures = []
    if (secondary) {
      try {
        await killAndWait(secondary, secondaryExited)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    try {
      await stop()
    } catch (error) {
      cleanupFailures.push(error)
    }
    if (host || secondary) {
      console.error('Native workspace retained in the system temporary directory', path.basename(root))
    } else {
      try {
        const cleanup = await realpath(root)
        assert.equal(path.dirname(cleanup), temp)
        assert.ok(path.basename(cleanup).startsWith(prefix))
        await rm(cleanup, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
        await onCleanup?.()
      } catch (error) {
        cleanupFailures.push(error)
      }
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
