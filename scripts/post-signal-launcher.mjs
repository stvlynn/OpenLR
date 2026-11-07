import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import {
  captureOriginalSignal,
  parseOriginalSignalRecords,
  waitForOriginalSignal
} from './post-signal-observer.mjs'

const contextMarker = 'OpenLR forwarded signal sig/code/pc/lr/sp '
const registersMarker = 'OpenLR forwarded registers fp/x0/x1/x2/x3/x19/x20/x21/x22/x23/x24 '
const prefix = 'OpenLR post signal host '
const safeError = (error) => ({ name: error?.name || 'Error', code: error?.code || null })

async function until(operation, milliseconds) {
  let timer
  try {
    return await Promise.race([
      operation.then((value) => ({ done: true, value })),
      new Promise((resolve) => (timer = setTimeout(() => resolve({ done: false }), milliseconds)))
    ])
  } finally {
    clearTimeout(timer)
  }
}

// The IPC parent supplies one application launch. This worker never adopts another PID.
export function runPostSignalWorker() {
  let config,
    host,
    hostClosed,
    capture,
    finishing,
    stopRequested = false
  let faultObserved = false,
    parentGone = false,
    markerTail = '',
    summary
  let forcedKill = false,
    terminationRequested = false,
    captureResult,
    captureFailure
  let helperCleanupConfirmed = true
  const signalsSent = []
  const gracefulWaits = []
  const diagnosticErrors = []
  const failedStreams = new Set()
  const decoder = new StringDecoder('utf8')
  const output = { stderr: '', closed: null, error: null, truncated: false }
  let resolveHostClosed
  const closed = new Promise((resolve) => (resolveHostClosed = resolve))
  const startedAt = performance.now()

  const publish = (phase, details = {}) => {
    const event = {
      phase,
      pid: host?.pid ?? null,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...details
    }
    console.error(prefix + JSON.stringify(event))
    if (process.connected) process.send({ type: 'event', event }, () => {})
  }
  const reply = (message) =>
    new Promise((resolve) => {
      if (!process.connected) return resolve(false)
      process.send(message, (error) => resolve(!error))
    })
  for (const stream of ['stdout', 'stderr']) {
    process[stream].on('error', (error) => {
      if (failedStreams.has(stream)) return
      failedStreams.add(stream)
      output.error = error.code || error.name
      diagnosticErrors.push({ stage: 'worker-output', stream, ...safeError(error) })
      host?.[stream]?.resume()
      if (host) void finish('output-error')
    })
  }

  async function persist() {
    if (!config) return
    try {
      await mkdir(config.directory, { recursive: true })
      await writeFile(
        path.join(config.directory, 'host-observation.json'),
        JSON.stringify(summary, null, 2) + '\n'
      )
    } catch (error) {
      diagnosticErrors.push({ stage: 'report-write', ...safeError(error) })
      publish('diagnostic-error', { stage: 'report-write', ...safeError(error) })
    }
  }

  function beginCapture() {
    if (capture || !output.stderr.includes(contextMarker) || !output.stderr.includes(registersMarker)) return
    faultObserved = true
    publish('capture-started')
    capture = (async () => {
      const original = await waitForOriginalSignal({ child: host, output })
      captureResult = await captureOriginalSignal({
        pid: host.pid,
        context: original.context,
        directory: config.directory,
        name: 'host'
      })
      helperCleanupConfirmed =
        captureResult.debuggerExit?.signal === null && captureResult.debuggerExit?.code === 0
      publish('capture-completed', {
        status: captureResult.record.status,
        sessionComplete: captureResult.record.sessionComplete,
        debuggerExit: captureResult.debuggerExit
      })
    })()
      .catch((error) => {
        captureFailure = {
          ...safeError(error),
          message: String(error?.message || error).slice(0, 1000),
          observation: error.observation || null
        }
        helperCleanupConfirmed = error.observation?.cleanupConfirmed !== false
        publish('capture-failed', {
          ...safeError(error),
          helperCleanupConfirmed,
          sessionComplete: error.observation?.record?.sessionComplete ?? false
        })
      })
      .finally(() => {
        // Fault cleanup also belongs to this worker if startup or the parent workflow stalls.
        void finish('capture-settled')
      })
  }

  function inspectStderr(chunk) {
    markerTail += decoder.write(chunk)
    let newline
    while ((newline = markerTail.indexOf('\n')) >= 0) {
      const line = markerTail.slice(0, newline).replace(/\r$/, '')
      markerTail = markerTail.slice(newline + 1)
      if (!line.startsWith(contextMarker) && !line.startsWith(registersMarker)) continue
      faultObserved = true
      if (output.stderr.length + line.length + 1 > 64 * 1024) {
        output.truncated = true
        continue
      }
      output.stderr += line + '\n'
      beginCapture()
    }
    if (markerTail.length > 8192) {
      if (markerTail.startsWith(contextMarker) || markerTail.startsWith(registersMarker)) {
        faultObserved = true
        output.truncated = true
      }
      markerTail = markerTail.slice(-8192)
    }
  }

  function sendOwnedSignal(signal) {
    if (!host || hostClosed || host.exitCode !== null || host.signalCode !== null) return
    try {
      const sent = host.kill(signal)
      signalsSent.push({ signal, sent })
      publish('host-signal-requested', { signal, sent })
    } catch (error) {
      diagnosticErrors.push({ stage: 'host-signal', signal, ...safeError(error) })
      publish('diagnostic-error', { stage: 'host-signal', signal, ...safeError(error) })
    }
  }

  async function finish(reason) {
    if (finishing) return finishing
    finishing = (async () => {
      // Let already-queued stderr chunks publish their complete signal records first.
      await new Promise((resolve) => setImmediate(resolve))
      await capture
      if (!hostClosed && host) {
        if (faultObserved) {
          sendOwnedSignal('SIGCONT')
          const waited = await until(closed, 10_000)
          gracefulWaits.push({ signal: 'SIGCONT', timeoutMs: 10_000, closed: waited.done })
        }
        await capture
        if (!hostClosed) {
          terminationRequested = true
          sendOwnedSignal('SIGTERM')
          const waited = await until(closed, 5000)
          gracefulWaits.push({ signal: 'SIGTERM', timeoutMs: 5000, closed: waited.done })
        }
        await capture
        if (!hostClosed) {
          forcedKill = true
          sendOwnedSignal('SIGKILL')
          const waited = await until(closed, 5000)
          gracefulWaits.push({ signal: 'SIGKILL', timeoutMs: 5000, closed: waited.done })
        }
      }
      await capture
      let records, parseError
      try {
        records = parseOriginalSignalRecords(output.stderr)
      } catch (error) {
        parseError = safeError(error)
      }
      const unexpectedSignal = Boolean(
        hostClosed?.signal &&
        !(
          ['SIGTERM', 'SIGKILL'].includes(hostClosed.signal) &&
          signalsSent.some(({ signal, sent }) => signal === hostClosed.signal && sent === true)
        )
      )
      const unexpectedExit = !stopRequested || faultObserved || unexpectedSignal
      const cleanupConfirmed = Boolean(hostClosed) && helperCleanupConfirmed
      const failed =
        unexpectedExit ||
        forcedKill ||
        !cleanupConfirmed ||
        Boolean(output.error) ||
        Boolean(captureFailure) ||
        Boolean(parseError) ||
        diagnosticErrors.length > 0
      summary = {
        pid: host?.pid ?? null,
        reason,
        stopRequested,
        faultObserved,
        hostExit: hostClosed,
        hostClosed: Boolean(hostClosed),
        signalsSent,
        gracefulWaits,
        terminationRequested,
        forcedKill,
        unexpectedExit,
        unexpectedSignal,
        capture: captureResult || captureFailure?.observation || null,
        captureFailure: captureFailure
          ? { name: captureFailure.name, code: captureFailure.code, message: captureFailure.message }
          : null,
        helperCleanupConfirmed,
        cleanupConfirmed,
        failed,
        records: records || null,
        parseError: parseError || null,
        diagnosticErrors
      }
      await persist()
      summary.failed ||= diagnosticErrors.length > 0
      publish('completed', {
        hostExit: hostClosed,
        faultObserved,
        forcedKill,
        helperCleanupConfirmed,
        cleanupConfirmed,
        failed: summary.failed
      })
      await reply({ type: 'complete', nonce: config?.nonce, summary })
      process.exitCode = cleanupConfirmed ? (summary.failed ? 1 : 0) : 2
      if (process.connected) process.disconnect()
    })()
    return finishing
  }

  function start(message) {
    if (
      config ||
      !path.isAbsolute(message.executable || '') ||
      !path.isAbsolute(message.directory || '') ||
      !Array.isArray(message.args) ||
      !message.args.every((arg) => typeof arg === 'string') ||
      typeof message.nonce !== 'string' ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(message.nonce) ||
      !message.env ||
      typeof message.env !== 'object' ||
      !Object.values(message.env).every((value) => typeof value === 'string')
    )
      throw Error('Invalid or duplicate owned application launch')
    config = message
    host = spawn(config.executable, config.args, {
      env: config.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    host.once('spawn', () => {
      publish('host-started')
      void reply({ type: 'ready', nonce: config.nonce, pid: host.pid })
    })
    const forward = (stream, chunk) => {
      if (failedStreams.has(stream)) return
      if (!process[stream].write(chunk)) {
        host[stream].pause()
        process[stream].once('drain', () => host[stream].resume())
      }
    }
    host.stdout.on('data', (chunk) => forward('stdout', chunk))
    host.stderr.on('data', (chunk) => {
      forward('stderr', chunk)
      inspectStderr(chunk)
    })
    host.once('error', (error) => {
      output.error = error.code || error.name
      diagnosticErrors.push({ stage: 'host-launch', ...safeError(error) })
      publish('diagnostic-error', { stage: 'host-launch', ...safeError(error) })
    })
    host.once('exit', (code, signal) => publish('host-exited', { code, signal }))
    host.once('close', (code, signal) => {
      hostClosed = output.closed = { code, signal }
      resolveHostClosed(hostClosed)
      publish('host-closed', hostClosed)
      void finish('host-closed')
    })
  }

  process.on('message', (message) => {
    if (message?.type === 'start') {
      try {
        start(message)
      } catch (error) {
        diagnosticErrors.push({ stage: 'worker-start', ...safeError(error) })
        publish('diagnostic-error', { stage: 'worker-start', ...safeError(error) })
        if (host) void finish('start-error')
        else {
          process.exitCode = 2
          if (process.connected) process.disconnect()
        }
      }
      return
    }
    if (!config || message?.nonce !== config.nonce) return
    if (message.type === 'settle')
      void (async () => {
        await new Promise((resolve) => setImmediate(resolve))
        await capture
        await reply({ type: 'settled', nonce: config.nonce, id: message.id })
      })()
    if (message.type === 'stop') {
      stopRequested = true
      void finish('parent-stop')
    }
  })
  process.on('disconnect', () => {
    if (parentGone) return
    parentGone = true
    if (host && !finishing) {
      stopRequested = true
      void finish('parent-disconnected')
    }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.send)
  runPostSignalWorker()
