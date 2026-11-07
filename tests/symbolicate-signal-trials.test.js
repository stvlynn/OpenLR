import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { inspectTrialSignal, symbolicateSignalTrials } from '../scripts/symbolicate-signal-trials.mjs'

const kernel = '/usr/lib/system/libsystem_kernel.dylib'
const jsc = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/JavaScriptCore'
const fixture = '/owned/generated-fixture.dylib'
const kernelUUID = '11111111222233334444555555555555'
const jscUUID = 'aaaaaaaa222233334444555555555555'
const otherUUID = 'bbbbbbbb222233334444555555555555'
const hex = (value) => '0x' + BigInt(value).toString(16).padStart(16, '0')
const context = { sig: hex(5), code: hex(0), pc: hex(0x1100), lr: hex(0xab00000000001200n), sp: hex(0x8000) }
const marker = 'OpenLR forwarded signal sig/code/pc/lr/sp ' + Object.values(context).join(' ') + ' \n'
const completed = {
  phase: 'completed',
  pid: 77,
  hostExit: { code: null, signal: 'SIGTRAP' },
  faultObserved: true,
  cleanupConfirmed: true,
  helperCleanupConfirmed: true
}
const postLine = (record) => 'OpenLR post signal host ' + JSON.stringify(record) + '\n'
const map = (pid, image, base, end) =>
  `dyld[${pid}]: Mapping ${image}\ndyld[${pid}]: __TEXT (r.x) ${base}->${end}\n`
const maps =
  map(77, jsc, '0x1000', '0x2000') +
  map(77, kernel, '0x3000', '0x4000') +
  map(77, fixture, '0x5000', '0x6000')
const postLog = maps + marker + postLine(completed)
const legacyLine =
  'Native workflow failure diagnostics: ' +
  JSON.stringify({ host: { pid: 77, exitCode: null, signal: 'SIGTRAP' } }) +
  '\n'
const legacyLog = maps + marker + legacyLine
const frame = (source, address, rawAddress = address, extra = {}) => ({
  source,
  address,
  rawAddress,
  status: 'mapped',
  image: 'JavaScriptCore',
  uuid: jscUUID,
  base: '0x1000',
  imageOffset: Number(BigInt(address) - 0x1000n),
  symbol: 'recorded_lldb_symbol',
  ...extra
})
function observation() {
  return {
    pid: 77,
    hostExit: { code: null, signal: 'SIGTRAP' },
    faultObserved: true,
    cleanupConfirmed: true,
    helperCleanupConfirmed: true,
    capture: {
      record: {
        pid: 77,
        nonce: 'capture-1',
        status: 'captured',
        error: null,
        resumeSuccess: true,
        sessionComplete: true,
        normalizationScope: 'process-masks-reported',
        context: {
          raw: { ...context },
          normalized: { pc: '0x1100', lr: '0x1200', sp: '0x8000', fp: '0x8100' }
        },
        frames: [
          frame('original-pc', '0x1100'),
          frame('original-lr', '0x1200', context.lr),
          frame('frame-record-0', '0x5100', '0xab00000000005100', {
            image: 'generated-fixture.dylib',
            uuid: otherUUID,
            base: '0x5000',
            imageOffset: 0x100
          })
        ]
      }
    }
  }
}

test('post-signal exits retain their source and independently associated canonical frames', () => {
  const signal = inspectTrialSignal(postLog, { postObservation: observation() })
  assert.equal(signal.pid, 77)
  assert.equal(signal.sourceType, 'post-signal-host')
  assert.deepEqual(signal.exitSources[0].record, completed)
  assert.equal(signal.exitSources[0].rawLine, postLine(completed).trimEnd())
  const [pc, lr, supplied] = signal.postSignalCapture.frames
  assert.equal(pc.image.path, jsc)
  assert.equal(pc.originalTargetUUID, jscUUID)
  assert.equal(lr.address, '0x1200')
  assert.equal(lr.rawAddress, context.lr)
  assert.equal(lr.previousInstruction.address, '0x11fc')
  assert.equal(lr.previousInstruction.rawReturnAddress, context.lr)
  assert.match(lr.previousInstruction.derivation, /not a proven call/)
  assert.equal(supplied.status, 'original-package-required')
  assert.equal(supplied.originalTargetUUID, otherUUID)
  assert.equal(supplied.recordedModuleOffset, 0x100)
  assert.equal(supplied.lldbSymbol, 'recorded_lldb_symbol')
  assert.equal(signal.postSignalCapture.record.nonce, 'capture-1')
})

test('multiple owned post-signal PIDs cannot be folded into one PID-free context', () => {
  const started = postLine({ phase: 'started', pid: 88 })
  assert.throws(() => inspectTrialSignal(started + postLog), /Multiple owned host PIDs/)
  assert.throws(() => inspectTrialSignal(legacyLog + started), /Multiple owned host PIDs/)
})

test('post-signal sidecars must agree with actual exit, PID and original context', () => {
  for (const mutate of [
    (value) => value.pid++,
    (value) => value.capture.record.pid++,
    (value) => (value.capture.record.context.raw.pc = '0x1104'),
    (value) => (value.capture.record.frames[1].rawAddress = '0x1200'),
    (value) => (value.hostExit = { code: 0, signal: null })
  ]) {
    const value = observation()
    mutate(value)
    assert.throws(() => inspectTrialSignal(postLog, { postObservation: value }))
  }
  assert.throws(() => inspectTrialSignal(maps + marker, { postObservation: observation() }), /owned SIGTRAP/)
  assert.throws(() => inspectTrialSignal('', { postObservation: observation() }), /owned SIGTRAP/)
  assert.throws(
    () => inspectTrialSignal(maps + marker + postLine({ ...completed, phase: 'capture-completed' })),
    /owned SIGTRAP/
  )
})

test('identical post-signal repeats remain explicit while legacy markers remain strictly single', () => {
  assert.equal(inspectTrialSignal(postLog + marker).contexts.length, 2)
  assert.throws(
    () => inspectTrialSignal(postLog + marker.replace(context.pc, hex(0x1104))),
    /must be identical/
  )
  const signal = inspectTrialSignal(legacyLog)
  assert.equal(signal.sourceType, 'legacy-diagnostics')
  assert.equal(signal.context.pc, context.pc)
  assert.equal(signal.postSignalCapture, undefined)
  assert.throws(() => inspectTrialSignal(legacyLog + marker), /exactly one/)
  assert.throws(
    () => inspectTrialSignal(legacyLog, { postObservation: observation() }),
    /own completed host exit/
  )
})

function uuidText(uuid) {
  return [uuid.slice(0, 8), uuid.slice(8, 12), uuid.slice(12, 16), uuid.slice(16, 20), uuid.slice(20)].join(
    '-'
  )
}
const identity = (image, uuid) => `${image} [arm64e]:\n${uuidText(uuid)}\n`
async function artifact(t, { post = true, sidecar = observation() } = {}) {
  const base = await realpath(os.tmpdir())
  const root = await mkdtemp(path.join(base, 'openlr-signal-symbolication-'))
  t.after(async () => {
    const target = await realpath(root)
    assert.equal(path.dirname(target), base)
    assert.ok(path.basename(target).startsWith('openlr-signal-symbolication-'))
    await rm(target, { recursive: true, force: true })
  })
  await mkdir(path.join(root, 'signal-calibration'), { recursive: true })
  await mkdir(path.join(root, 'video-export-trials'), { recursive: true })
  const calibrationImage = { path: kernel, uuid: kernelUUID, arch: 'arm64e', base: '0x3000' }
  await writeFile(
    path.join(root, 'signal-calibration', 'calibration.json'),
    JSON.stringify({
      verified: true,
      platform: 'darwin',
      arch: 'arm64',
      results: [
        {
          mode: 'raise',
          termination: 'SIGTRAP',
          context: { sig: hex(5), pc: '0x3100' },
          image: calibrationImage,
          images: [calibrationImage]
        }
      ]
    })
  )
  await writeFile(
    path.join(root, 'signal-calibration', 'source-system-images.log'),
    identity(kernel, kernelUUID) + identity(jsc, jscUUID)
  )
  await writeFile(
    path.join(root, 'video-export-trials', 'report.json'),
    JSON.stringify({
      platform: 'darwin',
      arch: 'arm64',
      complete: true,
      order: ['ordinary'],
      trials: [{ index: 0, candidate: 'ordinary', verified: false }]
    })
  )
  await writeFile(path.join(root, 'video-export-trials', '0-ordinary.log'), post ? postLog : legacyLog)
  if (post && sidecar) {
    await mkdir(path.join(root, 'video-export-trials', '0-post-signal'))
    await writeFile(
      path.join(root, 'video-export-trials', '0-post-signal', 'host-observation.json'),
      JSON.stringify(sidecar)
    )
  }
  return root
}
function appleTools({ currentJSC = jscUUID, currentKernel = kernelUUID } = {}) {
  const calls = []
  return {
    calls,
    run(args) {
      calls.push(args)
      const image = args.at(-1)
      return {
        command: 'xcrun',
        args,
        exitCode: 0,
        signal: null,
        error: null,
        stderr: '',
        truncated: false,
        stdout:
          args[0] === 'dyld_info'
            ? identity(image, image === kernel ? currentKernel : currentJSC)
            : args.includes(kernel)
              ? '__pthread_kill + 8\n'
              : 'example_symbol + 4\n'
      }
    }
  }
}

test('post-fault artifact uses recorded UUIDs, canonical RA and separate derived candidates', async (t) => {
  const root = await artifact(t)
  const tools = appleTools()
  const report = await symbolicateSignalTrials(root, tools)
  assert.equal(report.status, 'complete')
  assert.equal(report.symbolicationCapabilityVerified, true)
  assert.equal(report.ownedHostSIGTRAPCount, 1)
  assert.equal(report.originalTargetUUIDsRecorded, true)
  const trial = report.trials[0]
  assert.equal(
    trial.postSignalObservation,
    path.join('video-export-trials', '0-post-signal', 'host-observation.json')
  )
  assert.equal(trial.addresses.pc.status, 'symbolicated')
  assert.equal(trial.addresses.pc.originalTargetUUIDMatchesCurrent, true)
  assert.equal(trial.addresses.lr.address, '0x1200')
  assert.equal(trial.addresses.lr.rawAddress, context.lr)
  assert.equal(trial.addresses.lrPreviousInstruction.address, '0x11fc')
  assert.equal(trial.addresses.lrPreviousInstruction.rawReturnAddress, context.lr)
  assert.equal(trial.postSignalCapture.frames[2].status, 'original-package-required')
  assert.equal(
    tools.calls.some((args) => args.includes(fixture)),
    false
  )
})

test('captured system UUID mismatch blocks atos for that image', async (t) => {
  const sidecar = observation()
  for (const frame of sidecar.capture.record.frames.slice(0, 2)) frame.uuid = otherUUID
  const root = await artifact(t, { sidecar })
  const tools = appleTools()
  const report = await symbolicateSignalTrials(root, tools)
  assert.equal(report.symbolicationCapabilityVerified, true)
  assert.equal(report.trials[0].addresses.pc.status, 'image-mismatch')
  assert.equal(report.trials[0].addresses.pc.originalTargetUUIDMatchesCurrent, false)
  assert.equal(report.trials[0].addresses.pc.sourceHostImageMatchesCurrent, true)
  assert.equal(
    tools.calls.some((args) => args[0] === 'atos' && args.includes(jsc)),
    false
  )
})

test('artifact context mismatch is an evidence error before original-frame atos', async (t) => {
  const sidecar = observation()
  sidecar.capture.record.context.raw.pc = '0x1104'
  const root = await artifact(t, { sidecar })
  const tools = appleTools()
  const report = await symbolicateSignalTrials(root, tools)
  assert.equal(report.status, 'completed-with-evidence-errors')
  assert.equal(report.trials[0].status, 'evidence-error')
  assert.match(report.trials[0].error, /context differs at pc/)
  assert.equal(
    tools.calls.some((args) => args[0] === 'atos' && args.includes(jsc)),
    false
  )
})

test('legacy artifact retains absent target UUID scope and known kernel calibration', async (t) => {
  const root = await artifact(t, { post: false })
  const tools = appleTools()
  const report = await symbolicateSignalTrials(root, tools)
  assert.equal(report.status, 'complete')
  assert.equal(report.symbolicationCapabilityVerified, true)
  assert.equal(report.originalTargetUUIDsRecorded, false)
  assert.equal(report.trials[0].originalTargetUUIDsRecorded, false)
  assert.equal(report.trials[0].addresses.pc.originalTargetUUID, null)
  assert.equal(report.trials[0].addresses.pc.status, 'symbolicated')
})

test('mismatched calibration kernel blocks all atos even with directly recorded frame UUIDs', async (t) => {
  const root = await artifact(t)
  const tools = appleTools({ currentKernel: otherUUID })
  const report = await symbolicateSignalTrials(root, tools)
  assert.equal(report.calibrationKernelMatchesCurrent, false)
  assert.equal(report.symbolicationCapabilityVerified, false)
  assert.equal(report.trials[0].addresses.pc.status, 'kernel-unverified')
  assert.equal(
    tools.calls.some((args) => args[0] === 'atos'),
    false
  )
})
