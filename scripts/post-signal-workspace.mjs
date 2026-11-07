import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const launcherPath = fileURLToPath(new URL('./post-signal-launcher.mjs', import.meta.url))

async function within(operation, milliseconds, message) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((resolve, reject) => (timer = setTimeout(() => reject(Error(message)), milliseconds)))
    ])
  } finally {
    clearTimeout(timer)
  }
}

// One factory owns one host session; native-video does not restart its workspace.
export function createPostSignalWorkspace({ directory }) {
  if (!directory) throw Error('Post-signal observation requires a persistent diagnostic directory')
  const destination = path.resolve(directory)
  let owner
  function launch({ executable, args, env }) {
    if (owner) throw Error('Post-signal workspace already owns a host session')
    const nonce = randomUUID()
    // Actual host environment (including loader diagnostics) travels only through IPC.
    const child = fork(launcherPath, [], {
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true
    })
    let actualPid,
      summary,
      settled = false,
      sequence = 0,
      resolveReady,
      rejectReady
    const replies = new Map()
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    ready.catch(() => {})
    const closed = new Promise((resolve) =>
      child.once('close', (code, signal) => {
        settled = true
        if (!actualPid) rejectReady(Error('Post-signal worker exited before publishing its owned host PID'))
        for (const respond of replies.values()) respond()
        replies.clear()
        resolve({ code, signal, summary })
      })
    )
    child.once('error', rejectReady)
    child.on('message', (message) => {
      if (message?.nonce !== nonce) return
      if (message.type === 'ready') {
        if (!Number.isSafeInteger(message.pid) || message.pid <= 0 || actualPid) {
          rejectReady(Error('Post-signal worker returned an invalid or duplicate owned PID'))
          return
        }
        actualPid = message.pid
        resolveReady(actualPid)
      }
      if (message.type === 'complete') summary = message.summary
      if (message.type === 'settled') {
        replies.get(message.id)?.()
        replies.delete(message.id)
      }
    })
    const send = (message) => {
      if (!child.connected) return false
      child.send({ ...message, nonce }, () => {})
      return true
    }
    let stopRequested = false
    const stop = () => {
      if (!stopRequested && !settled) {
        stopRequested = true
        send({ type: 'stop' })
      }
    }
    const awaitCapture = async () => {
      if (settled) return
      const id = ++sequence
      const completed = new Promise((resolve) => replies.set(id, resolve))
      try {
        if (!send({ type: 'settle', id })) return
        await within(completed, 60_000, 'Post-signal capture did not settle before workspace shutdown')
      } finally {
        replies.delete(id)
      }
    }
    owner = { child, ready, stop, closed, awaitCapture }
    send({ type: 'start', executable, args, env, directory: destination })
    return { child, ready, stop }
  }

  function wrap(workflow) {
    return async (workspace) => {
      let value,
        primaryError,
        cleanupError,
        primaryFailed = false
      try {
        value = await workflow(workspace)
      } catch (error) {
        primaryFailed = true
        primaryError = error
      } finally {
        try {
          if (!owner) throw Error('Post-signal workflow has no owned launcher')
          let settleError
          try {
            await owner.awaitCapture()
          } catch (error) {
            settleError = error
          } finally {
            owner.stop()
          }
          const result = await within(owner.closed, 75_000, 'Post-signal worker cleanup did not complete')
          if (!result.summary?.cleanupConfirmed || result.signal !== null || ![0, 1].includes(result.code))
            throw Error('Post-signal worker could not confirm owned host and debugger cleanup')
          if (result.summary.failed || result.code !== 0)
            throw Error('Post-signal observation recorded a native host or capture failure')
          if (settleError) throw settleError
        } catch (error) {
          cleanupError = error
          console.error('Post-signal workspace diagnostic failure:', error.name)
        }
      }
      if (primaryFailed) throw primaryError
      if (cleanupError) throw cleanupError
      return value
    }
  }
  return { launch, wrap }
}
