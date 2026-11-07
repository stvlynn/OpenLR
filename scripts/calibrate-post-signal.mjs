import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { validateSignalCalibration } from './calibrate-signal-context.mjs'
import {
  captureOriginalSignal,
  originalRegisterNames as registerNames,
  parseOriginalSignalRecords,
  waitForOriginalSignal
} from './post-signal-observer.mjs'

assert.equal(process.platform, 'darwin', 'Post-signal calibration requires macOS')
assert.equal(process.arch, 'arm64', 'Post-signal calibration requires ARM64')
const directory = path.resolve('build/signal-calibration/post-signal')
await mkdir(directory, { recursive: true })
const baseline = JSON.parse(await readFile('build/signal-calibration/calibration.json', 'utf8'))
assert.equal(baseline.verified, true)
const executable = path.join(directory, 'signal-context-probe')
const library = path.resolve('build/signal-calibration/signal-context-native.dylib')
const report = { verified: false, cases: [] }

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

function launch(command, args, env = process.env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = { stdout: '', stderr: '', closed: null, error: null, truncated: false }
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

async function terminate(owner, continueOriginalSignal = false) {
  if (!owner || owner.output.closed) return
  if (continueOriginalSignal) {
    owner.child.kill('SIGCONT')
    try {
      await within(owner.output.completion, 10_000, 'Original signal did not finish during cleanup')
      return
    } catch {}
  }
  owner.child.kill('SIGTERM')
  try {
    await within(owner.output.completion, 2000, 'Owned process did not terminate')
  } catch {
    owner.child.kill('SIGKILL')
    await within(owner.output.completion, 5000, 'Owned process cleanup remains unconfirmed')
  }
}

async function runCase(mode, debuggerMode) {
  const name = `${mode}-${debuggerMode}`
  const record = { mode, debuggerMode, verified: false, cleanup: {} }
  report.cases.push(record)
  const probe = launch(executable, [library, mode], { ...process.env, DYLD_PRINT_SEGMENTS: '1' })
  let captureObservation
  try {
    assert.ok(Number.isSafeInteger(probe.child.pid) && probe.child.pid > 0)
    record.pid = probe.child.pid
    const stopped = await waitForOriginalSignal(probe)
    record.context = stopped.context
    record.stoppedState = stopped.stoppedState
    if (debuggerMode !== 'resume') {
      try {
        captureObservation = await captureOriginalSignal({
          pid: probe.child.pid,
          directory,
          name,
          context: { ...record.context, ...(debuggerMode === 'invalid' ? { fp: '0x0000000000000001' } : {}) }
        })
      } catch (error) {
        captureObservation = error.observation
        throw error
      }
      record.capture = captureObservation.record
    }
    record.continueRequested = probe.child.exitCode === null && probe.child.signalCode === null
    if (record.continueRequested) probe.child.kill('SIGCONT')
    await within(
      probe.output.completion,
      10_000,
      'Original signal forwarding did not finish after continuation'
    )
    assert.equal(probe.output.error, null)
    assert.equal(probe.output.truncated, false)
    record.termination = probe.output.closed
    const forwarded = parseOriginalSignalRecords(probe.output.stderr)
    record.forwardedContexts = forwarded.contexts
    record.forwardedRegisters = forwarded.registers
    const verified = validateSignalCalibration(
      {
        mode,
        pid: probe.child.pid,
        expired: false,
        ...probe.output.closed,
        stdout: probe.output.stdout,
        stderr: probe.output.stderr
      },
      baseline.runtimeSiUser,
      { allowIdenticalForwardedContexts: debuggerMode !== 'resume' }
    )
    assert.equal(record.forwardedRegisters.length, record.forwardedContexts.length)
    for (const registers of record.forwardedRegisters)
      assert.deepEqual(
        registers,
        Object.fromEntries(registerNames.map((name) => [name, record.context[name]])),
        'Repeated observer register records must match the first context exactly'
      )
    record.fixture = verified.ready
    record.image = verified.image
    if (debuggerMode === 'invalid') {
      assert.equal(record.capture.status, 'partial', 'Misaligned saved FP must stop reconstruction')
      assert.equal(record.capture.stopReason, 'unaligned-frame-pointer')
      assert.equal(record.capture.records.length, 0, 'Misaligned input must not trigger a memory read')
    } else if (debuggerMode === 'capture') {
      assert.ok(
        ['captured', 'partial'].includes(record.capture.status),
        record.capture.error || 'Capture failed'
      )
      assert.equal(record.capture.error, null)
      assert.equal(record.capture.context.raw.fp, record.context.fp)
      const frames = record.capture.frames
      assert.ok(frames.length >= 3, 'Original PC, original LR and at least one FP caller are required')
      assert.equal(frames[0].uuid.replaceAll('-', '').toLowerCase(), verified.image.uuid)
      const pc = BigInt(record.capture.context.normalized.pc)
      assert.equal(pc, BigInt(record.context.pc), 'Original instruction must not change under normalization')
      assert.equal(
        BigInt(frames[0].base),
        BigInt(verified.image.base),
        'Loaded image base must match fixture metadata'
      )
      assert.equal(BigInt(frames[0].imageOffset), pc - BigInt(verified.image.base))
      const fp = BigInt(record.capture.context.normalized.fp)
      assert.ok(
        fp >= BigInt(verified.ready.stackLow) && fp < BigInt(verified.ready.stackHigh),
        'Original FP must belong to the independently reported foreign-thread stack'
      )
      record.normalizedReturnAddresses = record.capture.records.filter(
        (entry) => entry.rawSavedLR && BigInt(entry.rawSavedLR) !== BigInt(entry.savedLR)
      ).length
      const fixtureUUID = verified.images.find((image) => image.role === 'fixture').uuid
      assert.ok(
        frames.slice(1).some((frame) => frame.uuid?.replaceAll('-', '').toLowerCase() === fixtureUUID),
        'Reconstructed callers must include the independently known foreign-thread fixture'
      )
      assert.ok(
        frames.slice(2).some((frame) => frame.uuid && /pthread/.test(frame.image || '')),
        'FP records must reach an independently mapped pthread caller'
      )
    }
    record.verified = true
  } catch (error) {
    record.error = { name: error.name, message: error.message }
    throw error
  } finally {
    if (captureObservation) {
      record.capture ??= captureObservation.record
      record.debuggerObservation = captureObservation
      record.cleanup.debugger = captureObservation.cleanupConfirmed
        ? captureObservation.debuggerExit
        : { error: captureObservation.cleanupError?.message || 'Debugger cleanup remains unconfirmed' }
      if (!captureObservation.cleanupConfirmed) record.verified = false
    }
    for (const [kind, owner] of [['fixture', probe]]) {
      if (!owner) continue
      try {
        await terminate(owner, kind === 'fixture')
        record.cleanup[kind] = owner.output.closed
        if (kind === 'fixture') record.termination = owner.output.closed
      } catch (error) {
        record.cleanup[kind] = { error: error.message }
        record.verified = false
      }
      await writeFile(path.join(directory, `${name}.${kind}.stdout.log`), owner.output.stdout)
      await writeFile(path.join(directory, `${name}.${kind}.stderr.log`), owner.output.stderr)
    }
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  }
  assert.equal(record.verified, true, 'All independent cleanup receipts are required')
}

try {
  const build = launch(
    path.join(process.env.GOROOT, 'bin', 'go'),
    [
      'build',
      '-trimpath',
      '-ldflags',
      '-X runtime.openlrFreezeSignal=1',
      '-o',
      executable,
      path.resolve('scripts/fixtures/signal-context-probe/main_darwin.go')
    ],
    { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: 'arm64' }
  )
  try {
    await within(build.output.completion, 120_000, 'Post-signal fixture compilation did not finish')
    assert.deepEqual(build.output.closed, { code: 0, signal: null })
    assert.equal(build.output.error, null)
  } finally {
    await terminate(build)
    await writeFile(path.join(directory, 'build.stdout.log'), build.output.stdout)
    await writeFile(path.join(directory, 'build.stderr.log'), build.output.stderr)
  }
  await runCase('brk0', 'resume')
  for (const mode of ['brk0', 'brk1', 'raise']) await runCase(mode, 'capture')
  await runCase('brk0', 'invalid')
  report.verified = report.cases.every((record) => record.verified)
} catch (error) {
  report.error = { name: error.name, message: error.message }
  process.exitCode = 1
} finally {
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(
    JSON.stringify({
      postSignalCalibration: report.verified ? 'passed' : 'failed',
      error: report.error || null
    })
  )
}
