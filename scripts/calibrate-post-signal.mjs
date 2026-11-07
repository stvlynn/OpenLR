import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseSignalContext, validateSignalCalibration } from './calibrate-signal-context.mjs'

assert.equal(process.platform, 'darwin', 'Post-signal calibration requires macOS')
assert.equal(process.arch, 'arm64', 'Post-signal calibration requires ARM64')
const directory = path.resolve('build/signal-calibration/post-signal')
await mkdir(directory, { recursive: true })
const baseline = JSON.parse(await readFile('build/signal-calibration/calibration.json', 'utf8'))
assert.equal(baseline.verified, true)
const executable = path.join(directory, 'signal-context-probe')
const library = path.resolve('build/signal-calibration/signal-context-native.dylib')
const marker = 'OpenLR forwarded registers fp/x0/x1/x2/x3/x19/x20/x21/x22/x23/x24 '
const captureMarker = 'OpenLR post signal capture '
const registerNames = ['fp', 'x0', 'x1', 'x2', 'x3', 'x19', 'x20', 'x21', 'x22', 'x23', 'x24']
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

function state(pid) {
  const result = spawnSync('/bin/ps', ['-o', 'state=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2000
  })
  assert.equal(result.error, undefined, 'Owned process state lookup must return')
  assert.equal(result.status, 0, 'Owned process must remain present')
  return result.stdout.trim()
}

function registerRecords(stderr) {
  const lines = stderr.split(/\r?\n/).filter((line) => line.startsWith(marker))
  return lines.map((line) => {
    const values = line.slice(marker.length).trim().split(' ')
    assert.equal(values.length, registerNames.length)
    for (const value of values) assert.match(value, /^0x[0-9a-f]{16}$/)
    return Object.fromEntries(registerNames.map((name, index) => [name, values[index]]))
  })
}

function context(stderr) {
  const original = parseSignalContext(stderr)
  const records = registerRecords(stderr)
  assert.equal(records.length, 1, 'Exactly one initial original register record is required')
  return { ...original, ...records[0] }
}

async function runCase(mode, debuggerMode) {
  const name = `${mode}-${debuggerMode}`
  const record = { mode, debuggerMode, verified: false, cleanup: {} }
  report.cases.push(record)
  const probe = launch(executable, [library, mode], { ...process.env, DYLD_PRINT_SEGMENTS: '1' })
  let debuggerOwner
  try {
    assert.ok(Number.isSafeInteger(probe.child.pid) && probe.child.pid > 0)
    record.pid = probe.child.pid
    await within(
      (async () => {
        while (!probe.output.stderr.includes(marker) || !probe.output.stderr.endsWith('\n')) {
          assert.equal(probe.output.closed, null, 'Fixture exited before publishing its original context')
          await delay(20)
        }
        while (!state(probe.child.pid).includes('T')) {
          assert.equal(probe.output.closed, null, 'Fixture exited before its opt-in stop')
          await delay(20)
        }
      })(),
      10_000,
      'Fixture did not stop after its original context record'
    )
    record.context = context(probe.output.stderr)
    record.stoppedState = state(probe.child.pid)
    if (debuggerMode !== 'resume') {
      const request = {
        pid: probe.child.pid,
        nonce: randomUUID(),
        context: {
          ...Object.fromEntries(
            Object.entries(record.context).filter(([, value]) => typeof value === 'string')
          ),
          ...(debuggerMode === 'invalid' ? { fp: '0x0000000000000001' } : {})
        }
      }
      const requestPath = path.join(directory, name + '.request.json')
      await writeFile(requestPath, JSON.stringify(request, null, 2) + '\n')
      debuggerOwner = launch('xcrun', [
        'lldb',
        '--batch',
        '--no-lldbinit',
        '-o',
        `command script import ${JSON.stringify(path.resolve('scripts/fixtures/post_signal_trace.py'))}`,
        '-o',
        `openlr-capture-signal ${JSON.stringify(requestPath)}`
      ])
      await within(debuggerOwner.output.completion, 45_000, 'Post-signal debugger did not finish')
      assert.equal(debuggerOwner.output.error, null)
      assert.deepEqual(debuggerOwner.output.closed, { code: 0, signal: null })
      assert.equal(debuggerOwner.output.truncated, false)
      const lines = debuggerOwner.output.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith(captureMarker))
      assert.equal(lines.length, 1, 'Expected one independent post-signal capture')
      record.capture = JSON.parse(lines[0].slice(captureMarker.length))
      assert.equal(record.capture.pid, probe.child.pid)
      assert.equal(record.capture.nonce, request.nonce)
      assert.equal(record.capture.detachSuccess, true, 'Debugger must detach from its owned fixture')
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
    record.forwardedContexts = verified.contextRecords
    record.forwardedRegisters = registerRecords(probe.output.stderr)
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
    for (const [kind, owner] of [
      ['debugger', debuggerOwner],
      ['fixture', probe]
    ]) {
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
