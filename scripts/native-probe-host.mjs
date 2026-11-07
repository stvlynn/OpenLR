import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { finished } from 'node:stream/promises'

export class ProbeHostUnconfirmedError extends Error {}

export async function runProbeHost(
  executable,
  args,
  { env, timeout = 75000, recordDirectory, ownGroup = false } = {}
) {
  const started = performance.now()
  const streams =
    recordDirectory &&
    ['stdout', 'stderr'].map((name) =>
      createWriteStream(path.join(recordDirectory, name + '.log'), { flags: 'wx' })
    )
  const streamCompletion = streams && Promise.allSettled(streams.map((stream) => finished(stream)))
  const child = spawn(executable, args, {
    env,
    detached: ownGroup && process.platform !== 'win32',
    windowsHide: true,
    stdio: streams ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit']
  })
  const receipt = {
    pid: child.pid ?? null,
    processGroup: ownGroup && process.platform !== 'win32' ? child.pid : null,
    forced: false,
    exitConfirmed: false,
    scope: 'Own spawned host/process group only; launchd-owned WebKit helpers are outside this receipt'
  }
  if (streams) {
    child.stdout.pipe(streams[0])
    child.stderr.pipe(streams[1])
  }
  let timedOut = false
  let killDeadline
  let rejectUnconfirmed
  const unconfirmed = new Promise((_, reject) => {
    rejectUnconfirmed = reject
  })
  const deadline = setTimeout(() => {
    timedOut = true
    receipt.forced = true
    // MyGo handles SIGTERM as a normal quit and can exit successfully on Unix.
    try {
      if (receipt.processGroup) process.kill(-receipt.processGroup, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch (error) {
      receipt.killError = error.message
    }
    if (recordDirectory)
      killDeadline = setTimeout(
        () => rejectUnconfirmed(new Error('Owned host did not close after termination')),
        5000
      )
  }, timeout)
  let status
  let failure
  try {
    status = await Promise.race([once(child, 'close'), unconfirmed])
    receipt.exitConfirmed = true
    ;[receipt.code, receipt.signal] = status
  } catch (error) {
    failure = error
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.unref()
      failure = new ProbeHostUnconfirmedError('Native probe host exit was not confirmed', { cause: error })
    }
  } finally {
    clearTimeout(deadline)
    clearTimeout(killDeadline)
    if (streams) {
      // An unconfirmed child may still own its pipe; stop retaining it here.
      if (!receipt.exitConfirmed) {
        child.stdout.destroy()
        child.stderr.destroy()
      }
      streams.forEach((stream) => stream.end())
      const results = await streamCompletion
      const failed = results.find((result) => result.status === 'rejected')
      if (failed) {
        receipt.streamError = failed.reason.message
        failure ??= failed.reason
      }
    }
    receipt.elapsedMs = Math.round(performance.now() - started)
    if (recordDirectory)
      await writeFile(path.join(recordDirectory, 'process.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  if (failure) throw Object.assign(failure, { ownership: receipt })
  const [code, signal] = status
  if (timedOut)
    throw Object.assign(Error(`Native probe timed out after ${timeout}ms`), { ownership: receipt })
  if (code !== 0 || signal !== null)
    throw Object.assign(Error(`Native probe host failed (${code ?? signal})`), { ownership: receipt })
  return receipt
}

export function profileEnvironment(profile) {
  const env = {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(profile, 'webview2'),
    APPDATA: profile,
    LOCALAPPDATA: profile,
    XDG_CONFIG_HOME: profile,
    XDG_DATA_HOME: profile,
    XDG_CACHE_HOME: profile,
    XDG_RUNTIME_DIR: profile
  }
  const { WAYLAND_DISPLAY: display, XDG_RUNTIME_DIR: runtime } = process.env
  if (process.platform === 'linux' && runtime && display && !path.isAbsolute(display))
    env.WAYLAND_DISPLAY = path.join(runtime, display)
  return env
}
