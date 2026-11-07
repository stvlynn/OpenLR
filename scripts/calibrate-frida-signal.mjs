import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { buildFridaSignalObserver } from './frida-signal-observer.mjs'
import { validateSignalCalibration } from './calibrate-signal-context.mjs'

assert.equal(process.platform, 'darwin', 'Frida signal calibration requires macOS')
assert.equal(process.arch, 'arm64', 'Frida signal calibration requires ARM64')
const directory = path.resolve('build/signal-calibration')
const destination = path.join(directory, 'frida')
await mkdir(destination, { recursive: true })
const baseline = JSON.parse(await readFile(path.join(directory, 'calibration.json'), 'utf8'))
assert.equal(baseline.verified, true)
const known = baseline.results.find((result) => result.mode === 'brk0')
const rea = process.env.OPENLR_REA_CLI
assert.ok(rea && path.isAbsolute(rea), 'Set OPENLR_REA_CLI to the provisioned REA entry script')
const nonce = randomUUID()
const readyPath = path.join(destination, 'ready.json')
const capturePath = path.join(destination, 'capture.json')
const sourcePath = path.join(destination, 'observer.js')
const report = { status: 'incomplete', nonce, fixture: null, controller: null, cleanup: {} }

function collect(child) {
  const result = { stdout: '', stderr: '', truncated: false, closed: null }
  const limit = 2 * 1024 * 1024
  for (const stream of ['stdout', 'stderr'])
    child[stream].setEncoding('utf8').on('data', (chunk) => {
      result.truncated ||= result[stream].length + chunk.length > limit
      result[stream] = (result[stream] + chunk).slice(0, limit)
    })
  result.completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      result.closed = { code, signal }
      resolve(result.closed)
    })
  })
  result.completion.catch(() => {})
  return result
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

async function waitFor(read, observed, milliseconds, message) {
  const deadline = performance.now() + milliseconds
  for (;;) {
    const value = await read()
    if (value) return value
    if (observed.closed) throw Error(message + ': controller process exited before readiness')
    if (performance.now() >= deadline) throw Error(message + ': readiness deadline exceeded')
    await delay(40)
  }
}

async function completeJson(filename) {
  try {
    const contents = await readFile(filename, 'utf8')
    return contents.endsWith('\n') ? JSON.parse(contents) : null
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

let fixture, fixtureOutput, controller, controllerOutput
try {
  fixture = spawn(path.join(directory, 'signal-context-probe'), [known.image.path, 'brk0'], {
    env: { ...process.env, OPENLR_SIGNAL_PROBE_WAIT: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  fixtureOutput = collect(fixture)
  assert.ok(Number.isSafeInteger(fixture.pid) && fixture.pid > 0)
  report.pid = fixture.pid
  await waitFor(
    () => fixtureOutput.stdout.includes(`"kind":"controller-ready","pid":${fixture.pid}`),
    fixtureOutput,
    15_000,
    'The owned fixture did not reach its instrumentation wait'
  )
  const offset = BigInt(known.image.address) - BigInt(known.image.base)
  await writeFile(
    sourcePath,
    buildFridaSignalObserver({
      ownedPid: fixture.pid,
      nonce,
      moduleName: path.basename(known.image.path),
      expectedUUID: known.image.uuid,
      targetOffset: offset.toString(),
      readyPath,
      capturePath
    }),
    { flag: 'wx' }
  )
  const started = performance.now()
  controller = spawn(
    process.execPath,
    [
      rea,
      'instrument-with-frida',
      'attach',
      String(fixture.pid),
      '--device-id',
      'local',
      '--script-file',
      sourcePath,
      '--duration-ms',
      '6000',
      '--json'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env }
  )
  controllerOutput = collect(controller)
  const ready = await waitFor(
    async () => {
      const failure = await completeJson(capturePath)
      if (failure?.kind === 'error') throw Error('Observer startup failed: ' + failure.reason)
      return completeJson(readyPath)
    },
    controllerOutput,
    30_000,
    'REA did not install the signal observer'
  )
  report.attachReadyMs = Math.round(performance.now() - started)
  assert.equal(ready.nativeSignalObserver, 1)
  assert.equal(ready.kind, 'ready')
  assert.equal(ready.pid, fixture.pid)
  assert.equal(ready.nonce, nonce)
  assert.equal(ready.frida.version, '17.23.2')
  assert.equal(ready.target.uuid, known.image.uuid)
  assert.equal(BigInt(ready.target.offset), offset)
  assert.equal(ready.target.instructionWord, known.ready.brk0Word)
  fixture.stdin.end('\n')
  report.fixture = await within(fixtureOutput.completion, 15_000, 'Instrumented fixture did not terminate')
  assert.equal(report.fixture.code, null)
  assert.equal(report.fixture.signal, 'SIGTRAP', 'The observer must preserve native SIGTRAP termination')
  report.controller = await within(controllerOutput.completion, 45_000, 'REA cleanup did not complete')
  assert.equal(report.controller.code, 0)
  assert.equal(report.controller.signal, null)
  assert.equal(fixtureOutput.truncated || controllerOutput.truncated, false)
  const evidence = JSON.parse(controllerOutput.stdout)
  report.evidence = {
    evidenceId: evidence.evidence_id,
    provider: evidence.provider,
    limitations: evidence.limitations,
    state: evidence.normalized_result?.state,
    cleanupError: evidence.normalized_result?.cleanup_error
  }
  assert.equal(evidence.normalized_result.pid, fixture.pid)
  assert.equal(evidence.normalized_result.mode, 'attach')
  assert.equal(evidence.normalized_result.cleanup_error, null)
  assert.equal(evidence.normalized_result.messages_truncated, false)
  const capture = await completeJson(capturePath)
  assert.equal(capture?.kind, 'capture')
  assert.equal(capture.pid, fixture.pid)
  assert.equal(capture.nonce, nonce)
  assert.equal(capture.target.uuid, known.image.uuid)
  const verified = validateSignalCalibration(
    {
      mode: 'brk0',
      expired: false,
      ...report.fixture,
      stdout: fixtureOutput.stdout,
      stderr: fixtureOutput.stderr
    },
    baseline.runtimeSiUser
  )
  const context = verified.context
  assert.equal(BigInt(capture.target.base), BigInt(verified.image.base))
  for (const register of ['pc', 'lr', 'sp'])
    assert.equal(BigInt(capture.registers[register]), BigInt(context[register]), 'Original ' + register)
  assert.equal(BigInt(capture.registers.pc) - BigInt(capture.target.base), offset)
  assert.equal(capture.backtracer, 'accurate')
  assert.ok(capture.frames.length >= 2, 'The observer must recover callers beyond the stopped instruction')
  assert.equal(capture.frames[0].uuid, known.image.uuid)
  assert.equal(BigInt(capture.frames[0].offset), BigInt(context.lr) - BigInt(capture.target.base))
  report.capture = capture
  report.runtimeContext = context
  report.status = 'passed'
} catch (error) {
  report.error = { name: error.name, message: error.message }
  process.exitCode = 1
} finally {
  for (const [name, child, output] of [
    ['fixture', fixture, fixtureOutput],
    ['controller', controller, controllerOutput]
  ]) {
    if (!child) continue
    try {
      if (!output.closed) {
        child.kill(name === 'fixture' ? 'SIGTERM' : 'SIGINT')
        try {
          await within(output.completion, 10_000, name + ' did not exit after shutdown')
        } catch {
          if (name === 'controller' && report.cleanup.fixture?.error)
            throw Error('Controller retained because target termination is unconfirmed')
          child.kill('SIGKILL')
          await within(output.completion, 5_000, name + ' exit remains unconfirmed')
        }
      }
      report.cleanup[name] = output.closed
    } catch (error) {
      report.cleanup[name] = { error: error.message }
      report.status = 'cleanup-unconfirmed'
      process.exitCode = 1
    }
    await writeFile(path.join(destination, name + '.stdout.log'), output.stdout)
    await writeFile(path.join(destination, name + '.stderr.log'), output.stderr)
  }
  await writeFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ fridaSignalCalibration: report.status, error: report.error || null }))
}
