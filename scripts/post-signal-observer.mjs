import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseSignalContexts } from './calibrate-signal-context.mjs'

const registerMarker = 'OpenLR forwarded registers fp/x0/x1/x2/x3/x19/x20/x21/x22/x23/x24 '
const captureMarker = 'OpenLR post signal capture '
const reader = fileURLToPath(new URL('./fixtures/post_signal_trace.py', import.meta.url))
export const originalRegisterNames = Object.freeze([
  'fp',
  'x0',
  'x1',
  'x2',
  'x3',
  'x19',
  'x20',
  'x21',
  'x22',
  'x23',
  'x24'
])

export function parseOriginalSignalRecords(stderr) {
  // A pipe chunk may end in the middle of a marker. Its owner retains the raw
  // stream; only complete newline-terminated records are eligible for parsing.
  const complete = stderr.slice(0, stderr.lastIndexOf('\n') + 1)
  const registers = complete
    .split(/\r?\n/)
    .filter((line) => line.startsWith(registerMarker))
    .map((line) => {
      const values = line.slice(registerMarker.length).trim().split(' ')
      assert.equal(values.length, originalRegisterNames.length, 'Expected eleven original register fields')
      for (const value of values) assert.match(value, /^0x[0-9a-f]{16}$/)
      return Object.fromEntries(originalRegisterNames.map((name, index) => [name, values[index]]))
    })
  return { contexts: parseSignalContexts(complete), registers }
}

function ownedPid(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff, 'Expected a positive owned PID')
}

async function within(operation, milliseconds, message) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error(message)), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function waitForOriginalSignal({ child, output, timeoutMs = 10_000, pollMs = 20 }) {
  ownedPid(child.pid)
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0)
  assert.ok(Number.isFinite(pollMs) && pollMs > 0)
  const deadline = performance.now() + timeoutMs
  for (;;) {
    assert.equal(child.exitCode, null, 'Owned process already exited before its original-context stop')
    assert.equal(child.signalCode, null, 'Owned process already received a terminal signal')
    assert.equal(output.closed, null, 'Owned process exited before its original-context stop')
    assert.equal(output.error, null, 'Owned process launch failed before its original-context stop')
    assert.equal(output.truncated, false, 'Original-context stream was truncated')
    const records = parseOriginalSignalRecords(output.stderr)
    if (records.contexts.length && records.registers.length && output.stderr.endsWith('\n')) {
      assert.equal(records.contexts.length, 1, 'Exactly one initial original context is required')
      assert.equal(records.registers.length, 1, 'Exactly one initial original register record is required')
      const remaining = deadline - performance.now()
      assert.ok(remaining > 0, 'Owned process did not stop after its original context record')
      const result = spawnSync('/bin/ps', ['-o', 'state=', '-p', String(child.pid)], {
        encoding: 'utf8',
        timeout: Math.min(2000, Math.max(1, Math.ceil(remaining)))
      })
      assert.equal(result.error, undefined, 'Owned process state lookup must return')
      assert.equal(result.status, 0, 'Owned process must remain present')
      const stoppedState = result.stdout.trim()
      if (stoppedState.includes('T'))
        return {
          context: { ...records.contexts[0], ...records.registers[0] },
          stoppedState,
          ...records
        }
    }
    assert.ok(performance.now() < deadline, 'Owned process did not stop after its original context record')
    await delay(Math.min(pollMs, Math.max(1, deadline - performance.now())))
  }
}

function launchDebugger(args) {
  const child = spawn('xcrun', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const output = { stdout: '', stderr: '', error: null, truncated: false, closed: null }
  for (const stream of ['stdout', 'stderr'])
    child[stream].setEncoding('utf8').on('data', (chunk) => {
      output.truncated ||= output[stream].length + chunk.length > 2 * 1024 * 1024
      output[stream] = (output[stream] + chunk).slice(0, 2 * 1024 * 1024)
    })
  child.once('error', (error) => (output.error = error.message))
  output.completion = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      output.closed = { code, signal }
      resolve(output.closed)
    })
  )
  return { child, output }
}

async function closeDebugger({ child, output }) {
  if (output.closed) return
  child.kill('SIGTERM')
  try {
    await within(output.completion, 2000, 'Owned debugger did not terminate')
  } catch {
    child.kill('SIGKILL')
    await within(output.completion, 5000, 'Owned debugger cleanup remains unconfirmed')
  }
}

// Both post-fault capture and code inspection share actual debugger ownership,
// deadlines, close confirmation, bounded streams, and persisted raw tool output.
export async function runOwnedDebugger({ args, observation, inspect }) {
  const owner = launchDebugger(args)
  let failure,
    inspected = false
  const retain = () => {
    inspected = true
    inspect(owner.output, observation)
  }
  try {
    await within(owner.output.completion, 45_000, 'Owned debugger did not finish')
    retain()
    assert.equal(owner.output.error, null)
    assert.deepEqual(owner.output.closed, { code: 0, signal: null })
    assert.equal(owner.output.truncated, false)
  } catch (error) {
    failure = error
  } finally {
    try {
      await closeDebugger(owner)
      observation.cleanupConfirmed = true
    } catch (error) {
      observation.cleanupError = { name: error.name, message: error.message }
      failure ??= error
    }
    observation.debuggerExit = owner.output.closed
    observation.debuggerError = owner.output.error
    observation.truncated = owner.output.truncated
    if (!inspected) {
      try {
        retain()
      } catch (error) {
        observation.parseError = { name: error.name, message: error.message }
        failure ??= error
      }
    }
    try {
      await writeFile(observation.stdoutPath, owner.output.stdout)
      await writeFile(observation.stderrPath, owner.output.stderr)
    } catch (error) {
      observation.persistenceError = { name: error.name, message: error.message }
      failure ??= error
    }
  }
  if (failure) {
    failure.observation = observation
    throw failure
  }
  return observation
}

export async function captureOriginalSignal({ pid, context, directory, name, nonce = randomUUID() }) {
  ownedPid(pid)
  assert.ok(path.isAbsolute(directory), 'Use an absolute capture directory')
  assert.match(name, /^[A-Za-z0-9_-]{1,100}$/)
  assert.match(nonce, /^[A-Za-z0-9_-]{1,128}$/)
  const requestContext = Object.fromEntries(
    Object.entries(context).filter(([, value]) => typeof value === 'string')
  )
  for (const [key, value] of Object.entries(requestContext)) {
    assert.match(key, /^[a-z][a-z0-9_]{0,31}$/)
    assert.match(value, /^0x[0-9a-fA-F]{1,16}$/)
  }
  for (const key of ['pc', 'lr', 'sp', 'fp'])
    assert.ok(key in requestContext, 'Expected original PC LR SP FP')
  assert.ok(Object.keys(requestContext).length <= 40, 'Original context exceeds the register bound')
  const observation = {
    record: null,
    debuggerExit: null,
    cleanupConfirmed: false,
    cleanupError: null,
    requestPath: path.join(directory, name + '.request.json'),
    stdoutPath: path.join(directory, name + '.debugger.stdout.log'),
    stderrPath: path.join(directory, name + '.debugger.stderr.log')
  }
  await mkdir(directory, { recursive: true })
  await writeFile(
    observation.requestPath,
    JSON.stringify({ pid, nonce, context: requestContext }, null, 2) + '\n'
  )
  const args = [
    'lldb',
    '--batch',
    '--no-lldbinit',
    '-o',
    `command script import ${JSON.stringify(reader)}`,
    '-o',
    `openlr-capture-signal ${JSON.stringify(observation.requestPath)}`
  ]
  return await runOwnedDebugger({
    args,
    observation,
    inspect(output) {
      const lines = output.stdout.split(/\r?\n/).filter((line) => line.startsWith(captureMarker))
      try {
        observation.captureRecords = lines.map((line) => JSON.parse(line.slice(captureMarker.length)))
      } catch (error) {
        observation.parseError = { name: error.name, message: error.message }
        throw error
      }
      if (observation.captureRecords.length === 1) observation.record = observation.captureRecords[0]
      assert.equal(lines.length, 1, 'Expected one independent post-signal capture')
      assert.equal(observation.record.pid, pid)
      assert.equal(observation.record.nonce, nonce)
      assert.equal(observation.record.resumeSuccess, true, 'Debugger must resume original signal forwarding')
      assert.equal(observation.record.sessionComplete, true, 'Debugger must observe its owned inferior exit')
    }
  })
}
