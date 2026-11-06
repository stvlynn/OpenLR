import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

export class ProbeHostUnconfirmedError extends Error {}

export async function runProbeHost(executable, args, { env, timeout = 75000 } = {}) {
  const child = spawn(executable, args, { env, stdio: ['ignore', 'inherit', 'inherit'] })
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    // MyGo handles SIGTERM as a normal quit and can exit successfully on Unix.
    child.kill('SIGKILL')
  }, timeout)
  let status
  try {
    status = await once(child, 'close')
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.unref()
      throw new ProbeHostUnconfirmedError('Native probe host exit was not confirmed', { cause: error })
    }
    throw error
  } finally {
    clearTimeout(deadline)
  }
  const [code, signal] = status
  if (timedOut) throw Error(`Native probe timed out after ${timeout}ms`)
  if (code !== 0) throw Error(`Native probe host failed (${code ?? signal})`)
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
