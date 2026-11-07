import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseDyldUUID } from './symbolicate-signal-trials.mjs'
import {
  captureOriginalSignal,
  parseOriginalSignalRecords,
  waitForOriginalSignal
} from './post-signal-observer.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = path.join(root, 'scripts', 'fixtures', 'jsc-stack-probe')
const prefix = 'OpenLR JSC stack probe '
const originalMarker = 'OpenLR forwarded signal sig/code/pc/lr/sp '
const expectedUUID = 'a6079469bb2538b3b603d712b7dbb43d'
export const stackComparisonOrder = Object.freeze([
  'native-c',
  'go-busy',
  'go-to-c',
  'go-to-c',
  'go-busy',
  'native-c'
])
const errorText = (error) => String(error?.stack || error).slice(0, 4000)
const hex = (value) => {
  assert.match(value, /^0x[0-9a-fA-F]{1,16}$/)
  return BigInt(value)
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

function launch(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = { stdout: '', stderr: '', error: null, closed: null, truncated: false }
  for (const stream of ['stdout', 'stderr'])
    child[stream].setEncoding('utf8').on('data', (chunk) => {
      output.truncated ||= output[stream].length + chunk.length > 2 * 1024 * 1024
      output[stream] = (output[stream] + chunk).slice(0, 2 * 1024 * 1024)
    })
  child.once('error', (error) => (output.error = errorText(error)))
  output.completion = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      output.closed = { code, signal }
      resolve(output.closed)
    })
  )
  return { child, output, signals: [] }
}

async function cleanup(owner, allowOriginalContinuation = false) {
  if (owner.output.closed) return
  const signal = (name) => {
    owner.signals.push({ signal: name, sent: owner.child.kill(name) })
  }
  if (allowOriginalContinuation) {
    signal('SIGCONT')
    try {
      await within(owner.output.completion, 10_000, 'Original signal did not finish')
      return
    } catch {}
  }
  signal('SIGTERM')
  try {
    await within(owner.output.completion, 2000, 'Owned process did not terminate')
  } catch {
    signal('SIGKILL')
    await within(owner.output.completion, 5000, 'Owned process cleanup remains unconfirmed')
  }
}

export function parseStackProbeRecords(stdout, pid, mode) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => {
      const record = JSON.parse(line.slice(prefix.length))
      assert.equal(record.pid, pid, 'Probe event belongs to another process')
      assert.equal(record.mode, mode, 'Probe event belongs to another mode')
      return record
    })
}

export function validateStackProbeRecords(records, { normalExit }) {
  const one = (event) => {
    const found = records.filter((record) => record.event === event)
    assert.equal(found.length, 1, 'Expected exactly one ' + event)
    return found[0]
  }
  const loaded = one('loaded-image')
  assert.equal(
    loaded.jscUUID.replaceAll('-', '').toLowerCase(),
    expectedUUID,
    'Loaded JSC identity differs from the observed cohort'
  )
  const native = one('mutator-native-stack')
  const low = hex(native.pthreadLow),
    origin = hex(native.pthreadOrigin)
  assert.ok(
    hex(native.sp) >= low && hex(native.sp) < origin,
    'Initial native SP must be inside pthread bounds'
  )
  assert.equal(origin - low, BigInt(native.pthreadSize))
  const setup = one('setup-returned')
  const waiting = one('waiting-stack')
  assert.ok(records.indexOf(waiting) > records.indexOf(setup))
  const sp = hex(waiting.sp)
  assert.equal(sp & 15n, 0n, 'Observed waiting SP must be aligned')
  const withinNativeBounds = sp >= low && sp < origin
  if (loaded.mode === 'go-busy') {
    one('callback-entry')
    assert.equal(withinNativeBounds, false, 'Go busy mode must actually observe a different stack')
  } else {
    assert.equal(withinNativeBounds, true, 'Native waiting mode must observe the pthread stack')
    assert.equal(hex(waiting.pthreadLow), low)
    assert.equal(hex(waiting.pthreadOrigin), origin)
    if (loaded.mode === 'go-to-c') one('callback-entry')
    else assert.equal(records.filter((record) => record.event === 'callback-entry').length, 0)
  }
  assert.ok(
    records.indexOf(one('collection-started')) > records.indexOf(waiting),
    'GC must start after waiting readiness'
  )
  if (normalExit) {
    const returned = one('collection-returned')
    assert.equal(returned.api, 'JSGarbageCollect')
    assert.equal(returned.synchronous, false)
    const exposure = one('exposure-ended')
    assert.ok(records.indexOf(exposure) > records.indexOf(returned))
    assert.equal(exposure.windowLimitMs, 6000)
    assert.equal(exposure.iterationLimit, 256)
    assert.ok(
      Number.isSafeInteger(exposure.iterations) && exposure.iterations >= 0 && exposure.iterations <= 256
    )
    assert.equal(exposure.gcFinalizationObserved, true, 'Normal comparison requires actual GC activity')
    assert.ok(
      Number.isSafeInteger(exposure.finalizersBeforeContextRelease) &&
        exposure.finalizersBeforeContextRelease > 0
    )
    const completed = one('completed')
    assert.equal(completed.ready, 1)
    assert.equal(completed.done, 1)
    assert.equal(completed.collectorJoined, true)
    assert.ok(records.indexOf(completed) > records.indexOf(exposure))
  }
  return {
    withinNativeBounds,
    waitingSP: waiting.sp,
    pthreadLow: native.pthreadLow,
    pthreadOrigin: native.pthreadOrigin,
    scope: 'Fixture observations only; no claim that JSC sampled the same SP or cached identical bounds'
  }
}

export async function runStackProbeCase({ mode, index, executable, library, directory }) {
  const name = `${index}-${mode}`
  const destination = path.join(directory, name)
  await mkdir(destination, { recursive: true })
  const result = { index, mode, complete: false, cleanupConfirmed: false, helperCleanupConfirmed: true }
  const owner = launch(executable, [library, mode], {
    ...process.env,
    DYLD_PRINT_SEGMENTS: '1',
    GOMAXPROCS: '2'
  })
  let observedSignal = false
  try {
    assert.ok(Number.isSafeInteger(owner.child.pid) && owner.child.pid > 0)
    result.pid = owner.child.pid
    const deadline = performance.now() + 20_000
    while (!owner.output.closed) {
      // Even malformed original-context evidence must be continued during
      // cleanup before considering termination of this owned frozen process.
      observedSignal ||= owner.output.stderr.split(/\r?\n/).some((line) => line.startsWith(originalMarker))
      assert.equal(owner.output.error, null)
      assert.equal(owner.output.truncated, false)
      const records = parseOriginalSignalRecords(owner.output.stderr)
      if (records.contexts.length && records.registers.length) {
        const original = await waitForOriginalSignal({ ...owner, timeoutMs: 3000 })
        result.context = original.context
        result.stoppedState = original.stoppedState
        try {
          result.capture = await captureOriginalSignal({
            pid: owner.child.pid,
            context: original.context,
            directory: destination,
            name: 'original'
          })
        } catch (error) {
          result.capture = error.observation || null
          throw error
        }
        if (!owner.output.closed) owner.signals.push({ signal: 'SIGCONT', sent: owner.child.kill('SIGCONT') })
        await within(owner.output.completion, 10_000, 'Original signal did not finish after capture')
        break
      }
      assert.ok(performance.now() < deadline, 'Owned probe exceeded its process deadline')
      await delay(10)
    }
    assert.equal(owner.output.error, null)
    assert.equal(owner.output.truncated, false)
    result.records = parseStackProbeRecords(owner.output.stdout, owner.child.pid, mode)
    const normalExit = owner.output.closed.code === 0 && owner.output.closed.signal === null
    result.stackObservation = validateStackProbeRecords(result.records, { normalExit })
    result.collectionReturned = result.records.some((record) => record.event === 'collection-returned')
    result.forwarded = parseOriginalSignalRecords(owner.output.stderr)
    result.outcome = normalExit ? 'native-finalization-observed-normal-exit' : 'native-failure'
    if (normalExit) {
      assert.equal(
        observedSignal,
        false,
        'A forwarded original fault cannot become a normal comparison result'
      )
      assert.equal(result.forwarded.contexts.length, 0)
    } else {
      assert.deepEqual(
        owner.output.closed,
        { code: null, signal: 'SIGTRAP' },
        'Retain unexpected native failure as incomplete evidence'
      )
      assert.equal(observedSignal, true, 'SIGTRAP requires its captured original context')
      assert.ok(result.capture?.record)
      assert.equal(result.capture.record.resumeSuccess, true)
      assert.equal(result.capture.record.sessionComplete, true)
      assert.ok(result.forwarded.contexts.length > 0)
      assert.equal(result.forwarded.registers.length, result.forwarded.contexts.length)
      for (const context of result.forwarded.contexts) assert.deepEqual(context, result.forwarded.contexts[0])
      for (const registers of result.forwarded.registers)
        assert.deepEqual(registers, result.forwarded.registers[0])
      assert.equal(BigInt(result.forwarded.contexts[0].sig), 5n)
      result.outcome = 'captured-native-sigtrap'
    }
    result.complete = true
  } catch (error) {
    result.error = errorText(error)
  } finally {
    try {
      await cleanup(owner, observedSignal)
    } catch (error) {
      result.cleanupError = errorText(error)
    }
    result.hostExit = owner.output.closed
    result.signalsSent = owner.signals
    result.cleanupConfirmed = owner.output.closed !== null
    if (result.capture) result.helperCleanupConfirmed = result.capture.cleanupConfirmed === true
    result.complete &&= result.cleanupConfirmed && result.helperCleanupConfirmed
    await writeFile(path.join(destination, 'stdout.log'), owner.output.stdout)
    await writeFile(path.join(destination, 'stderr.log'), owner.output.stderr)
    try {
      result.records ??= parseStackProbeRecords(owner.output.stdout, owner.child.pid, mode)
    } catch (error) {
      result.parseError = errorText(error)
      result.complete = false
    }
    await writeFile(path.join(destination, 'observation.json'), JSON.stringify(result, null, 2) + '\n')
  }
  return result
}

async function main() {
  const directory = path.resolve(process.argv[2] || path.join(root, 'build', 'jsc-stack-comparison'))
  await mkdir(directory, { recursive: true })
  const report = {
    verified: false,
    platform: process.platform,
    arch: process.arch,
    expectedJSCUUID: expectedUUID,
    order: stackComparisonOrder,
    complete: false,
    results: [],
    scope:
      'Six-process public JSC collection pilot, two observations per waiting stack. A native finalizer before context release confirms GC activity; API return alone does not. Zero faults are inconclusive. Fixture SP observations are not JSC suspended samples.',
    verificationScope:
      'Owned process protocol, observed waiting stacks, native finalizer activity and cleanup; not a full GC-phase trace or a causal integration fix',
    collectionAPI: 'JSGarbageCollect',
    collectionProof: 'native JSClass finalizer before context release',
    activeExposureWindowLimitMs: 6000,
    allocationIterationLimit: 256
  }
  try {
    assert.equal(process.platform, 'darwin', 'JSC stack comparison requires macOS')
    assert.equal(process.arch, 'arm64', 'JSC stack comparison requires ARM64')
    const calibration = JSON.parse(
      await readFile(path.join(root, 'build', 'signal-calibration', 'post-signal', 'report.json'), 'utf8')
    )
    assert.equal(calibration.verified, true, 'Post-fault calibration must pass before the comparison')
    report.postSignalCalibrationVerified = true
    const go = process.env.GO_BINARY || 'go'
    const env = { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: 'arm64', GOTOOLCHAIN: 'local' }
    const checkedTool = (command, args, options = {}) => {
      const result = spawnSync(command, args, {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        ...options
      })
      report.build ??= []
      report.build.push({
        command,
        args,
        code: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error ? errorText(result.error) : null
      })
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, command + ' failed')
      return result.stdout.trim()
    }
    const jsc = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/JavaScriptCore'
    report.currentJSC = parseDyldUUID(
      checkedTool('xcrun', ['dyld_info', '-arch', 'arm64e', '-uuid', jsc]),
      jsc
    )
    assert.equal(report.currentJSC.uuid, expectedUUID, 'Current JSC must match the observed cohort')
    assert.equal(checkedTool(go, ['env', 'GOVERSION']), 'go1.27.3')
    const goroot = checkedTool(go, ['env', 'GOROOT'])
    assert.ok(
      (await readFile(path.join(goroot, 'src', 'runtime', 'signal_unix.go'), 'utf8')).includes(
        'var openlrFreezeSignal = "0"'
      ),
      'Use the prepared isolated signal toolchain'
    )
    report.runtime = { version: 'go1.27.3', cgoEnabled: false, freezeOriginalSignal: true }
    const library = path.join(directory, 'jsc-stack-native.dylib')
    const executable = path.join(directory, 'jsc-stack-probe')
    checkedTool('xcrun', [
      'clang',
      '-std=c11',
      '-arch',
      'arm64',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-dynamiclib',
      '-framework',
      'JavaScriptCore',
      '-pthread',
      path.join(fixture, 'native', 'probe.c'),
      '-o',
      library
    ])
    checkedTool(go, [
      'build',
      '-trimpath',
      '-ldflags=-X runtime.openlrFreezeSignal=1',
      '-o',
      executable,
      './scripts/fixtures/jsc-stack-probe'
    ])
    report.buildInfo = checkedTool(go, ['version', '-m', executable])
    assert.match(report.buildInfo, /github\.com\/ebitengine\/purego\s+v0\.11\.1\b/)
    assert.match(report.buildInfo, /CGO_ENABLED=0/)
    for (const [index, mode] of stackComparisonOrder.entries()) {
      const result = await runStackProbeCase({ mode, index, executable, library, directory })
      report.results.push(result)
      await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
      console.log(
        JSON.stringify({
          jscStackComparison: 1,
          index,
          mode,
          outcome: result.outcome || 'incomplete',
          hostExit: result.hostExit,
          cleanupConfirmed: result.cleanupConfirmed,
          helperCleanupConfirmed: result.helperCleanupConfirmed
        })
      )
      if (!result.cleanupConfirmed || !result.helperCleanupConfirmed) break
    }
    report.complete =
      report.results.length === stackComparisonOrder.length &&
      report.results.every((result) => result.complete)
    const controls = report.results.filter((result) => result.mode !== 'go-busy')
    report.controlsVerified =
      controls.length === 4 &&
      controls.every((result) => result.outcome === 'native-finalization-observed-normal-exit')
    report.observedSIGTRAPs = Object.fromEntries(
      ['native-c', 'go-busy', 'go-to-c'].map((mode) => [
        mode,
        report.results.filter((result) => result.mode === mode && result.hostExit?.signal === 'SIGTRAP')
          .length
      ])
    )
    report.verified = report.complete && report.controlsVerified
  } catch (error) {
    report.error = errorText(error)
  } finally {
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  }
  console.log(
    JSON.stringify({
      jscStackComparison: 1,
      verified: report.verified,
      complete: report.complete,
      observedSIGTRAPs: report.observedSIGTRAPs || null,
      directory
    })
  )
  if (!report.verified) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.stack || error)
    process.exitCode = 1
  })
