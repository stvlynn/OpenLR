import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mappedSignalImage, parseSignalContext, parseSignalContexts } from './calibrate-signal-context.mjs'

const marker = 'OpenLR forwarded signal sig/code/pc/lr/sp '
const diagnosticPrefixes = ['Native workflow failure diagnostics: ', 'Native startup diagnostics: ']
const postSignalPrefix = 'OpenLR post signal host '
const kernelPath = '/usr/lib/system/libsystem_kernel.dylib'
const javaScriptCorePath = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/JavaScriptCore'
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const normalizeUUID = (uuid) => uuid.replaceAll('-', '').toLowerCase()
const errorText = (error) => String(error?.message || error).slice(0, 2048)
const systemImage = (imagePath) =>
  imagePath.startsWith('/usr/lib/') || imagePath.startsWith('/System/Library/')

// Associate a runtime marker with one harness-owned SIGTRAP host.
function ownedTrialDiagnostics(log) {
  const diagnostics = []
  for (const line of log.split(/\r?\n/)) {
    const prefix = diagnosticPrefixes.find((prefix) => line.startsWith(prefix))
    if (!prefix && !line.startsWith(postSignalPrefix)) continue
    const record = JSON.parse(line.slice((prefix || postSignalPrefix).length))
    if (!prefix) {
      if (record.pid === null && !record.hostExit) continue
      assert.ok(
        Number.isSafeInteger(record.pid) && record.pid > 0,
        'Post-signal diagnostics require an owned PID'
      )
      const exit = record.phase === 'completed' ? record.hostExit : null
      if (exit?.signal === 'SIGTRAP') {
        assert.equal(exit.code, null, 'A signaled owned exit cannot also have an exit code')
        for (const key of ['faultObserved', 'cleanupConfirmed', 'helperCleanupConfirmed'])
          assert.equal(typeof record[key], 'boolean', 'Post-signal exit must retain ' + key)
      }
      diagnostics.push({
        host: { pid: record.pid, exitCode: exit?.code ?? null, signal: exit?.signal ?? null },
        sourceType: 'post-signal-host',
        sourceRecord: record,
        rawLine: line
      })
      continue
    }
    assert.ok(
      Number.isSafeInteger(record.host?.pid) && record.host.pid > 0,
      'Failure diagnostics must identify a positive owned host PID'
    )
    diagnostics.push({ ...record, sourceType: prefix.trim(), sourceRecord: record, rawLine: line })
  }
  return diagnostics
}

export function inspectTrialSignal(log, { postObservation } = {}) {
  const diagnostics = ownedTrialDiagnostics(log)
  const traps = diagnostics.filter((record) => record.host.signal === 'SIGTRAP')
  const markerPresent = log.split(/\r?\n/).some((line) => line.startsWith(marker))
  if (!traps.length) {
    assert.equal(markerPresent, false, 'Original marker requires an owned SIGTRAP host exit')
    assert.notEqual(
      postObservation?.hostExit?.signal,
      'SIGTRAP',
      'Post-signal sidecar requires an owned SIGTRAP log exit'
    )
    return null
  }
  const pids = [...new Set(diagnostics.map((record) => record.host.pid))]
  assert.equal(pids.length, 1, 'Multiple owned host PIDs make the PID-free runtime marker ambiguous')
  const postSignal = traps.some((record) => record.sourceType === 'post-signal-host')
  const contexts = postSignal ? parseSignalContexts(log) : [parseSignalContext(log)]
  assert.ok(contexts.length > 0, 'Owned SIGTRAP requires its original runtime context')
  const context = contexts[0]
  for (const repeated of contexts)
    assert.deepEqual(repeated, context, 'Repeated post-signal contexts must be identical')
  for (const exit of traps.filter((record) => record.sourceType === 'post-signal-host'))
    assert.equal(
      exit.sourceRecord.faultObserved,
      true,
      'Original post-signal context requires an observed fault'
    )
  assert.equal(BigInt(context.sig), 5n, 'Original marker signal differs from the owned SIGTRAP exit')
  const pid = pids[0]
  const addresses = Object.fromEntries(
    [
      ['pc', context.pc],
      ['lr', context.lr],
      ['lrPreviousInstruction', '0x' + (BigInt(context.lr) - 4n).toString(16)]
    ].map(([register, address]) => {
      try {
        const image = mappedSignalImage(log, pid, address)
        return [
          register,
          { address, image, moduleOffset: '0x' + (BigInt(address) - BigInt(image.base)).toString(16) }
        ]
      } catch (error) {
        return [register, { address, status: 'unmapped', error: errorText(error) }]
      }
    })
  )
  addresses.lrPreviousInstruction.derivation =
    'LR minus one ARM64 instruction; a possible call site when LR holds the return address'
  const result = {
    pid,
    host: traps.at(-1).host,
    context,
    contexts,
    addresses,
    sourceType: postSignal ? 'post-signal-host' : 'legacy-diagnostics',
    exitSources: traps.map(({ sourceType, sourceRecord, rawLine }) => ({
      sourceType,
      record: sourceRecord,
      rawLine
    }))
  }
  if (postObservation !== undefined)
    result.postSignalCapture = associatePostCapture(log, result, postObservation)
  return result
}

function addressValue(value) {
  assert.match(value, /^0x[0-9a-fA-F]{1,16}$/, 'Expected a recorded unsigned hexadecimal address')
  return BigInt(value)
}

function capturedAddress(log, pid, frame, address = frame.address) {
  const result = {
    source: frame.source,
    address,
    rawAddress: frame.rawAddress,
    recordedImage: frame.image ?? null,
    recordedBase: frame.base ?? null,
    recordedModuleOffset: frame.imageOffset ?? null,
    originalTargetUUID: frame.uuid ? normalizeUUID(frame.uuid) : null,
    lldbSymbol: frame.symbol ?? null,
    recordedStatus: frame.status
  }
  try {
    const canonical = addressValue(address)
    addressValue(frame.rawAddress)
    assert.equal(canonical & 3n, 0n, 'Recorded code address is not aligned')
    assert.equal(frame.status, 'mapped', 'LLDB did not identify the recorded code image')
    assert.match(result.originalTargetUUID, /^[0-9a-f]{32}$/)
    const recordedBase = addressValue(frame.base)
    assert.ok(
      Number.isSafeInteger(frame.imageOffset) && frame.imageOffset >= 0,
      'Recorded image offset is invalid'
    )
    assert.equal(
      addressValue(frame.address) - recordedBase,
      BigInt(frame.imageOffset),
      'Captured image offset disagrees with its address'
    )
    const image = mappedSignalImage(log, pid, address)
    assert.equal(BigInt(image.base), recordedBase, 'Owned loader map differs from captured image base')
    assert.equal(
      path.posix.basename(image.path),
      frame.image,
      'Owned loader map differs from captured image basename'
    )
    result.image = image
    result.moduleOffset = '0x' + (canonical - recordedBase).toString(16)
    if (!systemImage(image.path)) {
      result.status = 'original-package-required'
      result.scope =
        'Non-system image is not supplied; recorded UUID, offset and LLDB symbol are retained without atos'
    }
  } catch (error) {
    result.status = 'recorded-image-unavailable'
    result.error = errorText(error)
  }
  return result
}

function associatePostCapture(log, signal, observation) {
  assert.equal(
    signal.sourceType,
    'post-signal-host',
    'Post-signal capture requires its own completed host exit'
  )
  assert.equal(observation.pid, signal.pid, 'Post-signal sidecar belongs to another owned PID')
  assert.deepEqual(
    observation.hostExit,
    { code: null, signal: 'SIGTRAP' },
    'Post-signal sidecar must retain the actual SIGTRAP exit'
  )
  assert.equal(observation.faultObserved, true)
  const record = observation.capture?.record
  assert.ok(record && typeof record === 'object', 'Post-signal sidecar contains no debugger capture record')
  assert.equal(record.pid, signal.pid, 'Debugger capture belongs to another owned PID')
  assert.ok(
    Array.isArray(record.frames) && record.frames.length > 0 && record.frames.length <= 14,
    'Debugger frame count exceeds its bound'
  )
  for (const [name, value] of Object.entries(signal.context).filter(([, value]) => typeof value === 'string'))
    assert.equal(
      addressValue(record.context?.raw?.[name]),
      addressValue(value),
      'Debugger original context differs at ' + name
    )
  assert.equal(
    addressValue(record.context?.normalized?.pc),
    addressValue(record.frames?.[0]?.address),
    'Original PC frame differs from normalized captured PC'
  )
  assert.equal(record.frames[0].source, 'original-pc')
  for (const name of ['pc', 'lr']) {
    const frame = record.frames.find((frame) => frame.source === 'original-' + name)
    if (!frame) continue
    assert.equal(
      addressValue(frame.rawAddress),
      addressValue(record.context.raw[name]),
      'Original frame differs from raw captured ' + name
    )
    assert.equal(
      addressValue(frame.address),
      addressValue(record.context.normalized[name]),
      'Original frame differs from normalized captured ' + name
    )
  }
  const exits = signal.exitSources.filter((exit) => exit.sourceType === 'post-signal-host')
  for (const exit of exits)
    for (const key of ['cleanupConfirmed', 'helperCleanupConfirmed'])
      assert.equal(observation[key], exit.record[key], 'Post-signal cleanup differs between log and sidecar')
  const frames = record.frames.map((frame) => {
    const result = capturedAddress(log, signal.pid, frame)
    if (frame.source !== 'original-pc') {
      try {
        const address = addressValue(frame.address)
        assert.ok(address >= 4n, 'Return address has no preceding ARM64 instruction')
        result.previousInstruction = capturedAddress(
          log,
          signal.pid,
          frame,
          '0x' + (address - 4n).toString(16)
        )
        result.previousInstruction.rawReturnAddress = frame.rawAddress
        result.previousInstruction.derivation =
          'Canonical return address minus four; derived symbol candidate, not a proven call instruction'
      } catch (error) {
        result.previousInstruction = { status: 'candidate-unavailable', error: errorText(error) }
      }
    }
    return result
  })
  return {
    status: 'associated',
    pid: record.pid,
    nonce: record.nonce,
    captureStatus: record.status,
    captureError: record.error,
    resumeSuccess: record.resumeSuccess,
    sessionComplete: record.sessionComplete,
    normalizationScope: record.normalizationScope,
    record,
    frames,
    scope: 'Loaded UUIDs apply only to these independently PID/context-associated debugger frames'
  }
}

export function parseDyldUUID(stdout, imagePath) {
  // Apple's dyld_info prints the image architecture, then its UUID.
  const blocks = []
  let current
  for (const line of stdout.split(/\r?\n/)) {
    const header = line.match(/^(\/.*) \[(arm64e?)\]:\s*$/)
    if (header) {
      current = { path: header[1], arch: header[2] }
      blocks.push(current)
    } else if (current) {
      const uuid = line.trim().match(new RegExp(`^(${uuidPattern})$`, 'i'))
      if (uuid) {
        assert.equal(current.uuid, undefined, 'dyld_info returned duplicate UUIDs for one image')
        current.uuid = normalizeUUID(uuid[1])
      }
    }
  }
  const matches = blocks.filter((block) => block.path === imagePath && block.uuid)
  assert.equal(matches.length, 1, 'dyld_info must identify exactly one ARM64 image UUID and architecture')
  return matches[0]
}

function runAppleTool(args) {
  const limit = 64 * 1024
  const result = spawnSync('xcrun', args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: limit,
    shell: false
  })
  const stdout = result.stdout || '',
    stderr = result.stderr || ''
  return {
    command: 'xcrun',
    args,
    exitCode: result.status,
    signal: result.signal,
    error: result.error ? errorText(result.error) : null,
    stdout: stdout.slice(0, limit),
    stderr: stderr.slice(0, limit),
    truncated: stdout.length > limit || stderr.length > limit || result.error?.code === 'ENOBUFS'
  }
}

function checkedImage(imagePath, arch, run) {
  const tool = run(['dyld_info', '-arch', arch, '-uuid', imagePath])
  try {
    assert.equal(tool.exitCode, 0, 'dyld_info failed')
    assert.equal(tool.error, null, 'dyld_info returned an execution error')
    assert.equal(tool.truncated, false, 'dyld_info output exceeded the evidence bound')
    return { ...parseDyldUUID(tool.stdout, imagePath), tool }
  } catch (error) {
    return { path: imagePath, status: 'image-unavailable', error: errorText(error), tool }
  }
}

function symbolicateAddress(address, image, currentImage, run) {
  const tool = run(['atos', '-arch', currentImage.arch, '-o', image.path, '-l', image.base, address])
  const symbols = tool.stdout.trim()
  const resolved =
    tool.exitCode === 0 &&
    tool.error === null &&
    !tool.truncated &&
    symbols.length > 0 &&
    !/^0x[0-9a-f]+(?:\s|$)/i.test(symbols) &&
    !/^\?\?/.test(symbols)
  return { tool, resolved }
}

function calibrationImages(calibration) {
  const images = new Map()
  for (const result of calibration.results || []) {
    for (const image of result.images || []) {
      if (!image.path.startsWith('/usr/lib/') && !image.path.startsWith('/System/Library/')) continue
      const uuid = normalizeUUID(image.uuid)
      assert.match(uuid, /^[0-9a-f]{32}$/)
      assert.ok(
        !images.has(image.path) || images.get(image.path).uuid === uuid,
        'Calibration records disagree about a system image UUID'
      )
      images.set(image.path, { path: image.path, uuid, arch: image.arch })
    }
  }
  return images
}

export async function symbolicateSignalTrials(artifactRoot, { run = runAppleTool } = {}) {
  const source = path.resolve(artifactRoot)
  const report = {
    artifactRoot: source,
    status: 'incomplete',
    scope:
      'Original loader maps establish owned PID, module and offset. Associated post-signal frames retain their directly recorded loaded UUIDs; legacy addresses without such frames retain absent-target-UUID scope. Calibration UUIDs identify calibration-process system images; current-host symbolication uses the recorded identity comparisons.',
    originalTargetUUIDsRecorded: false,
    originalTargetUUIDScope:
      'Per associated post-signal frame only; no UUID identity is inferred for legacy or unavailable frames',
    trialsInspected: 0,
    ownedHostSIGTRAPCount: 0,
    markerCount: 0,
    trials: [],
    errors: []
  }
  let calibration, trials, sourceImages
  try {
    calibration = JSON.parse(
      await readFile(path.join(source, 'signal-calibration', 'calibration.json'), 'utf8')
    )
    assert.equal(calibration.verified, true, 'Source runtime calibration is unverified')
    assert.equal(calibration.platform, 'darwin')
    assert.equal(calibration.arch, 'arm64')
    trials = JSON.parse(await readFile(path.join(source, 'video-export-trials', 'report.json'), 'utf8'))
    assert.equal(trials.platform, 'darwin')
    assert.equal(trials.arch, 'arm64')
    assert.ok(Array.isArray(trials.trials))
    sourceImages = calibrationImages(calibration)
    assert.ok(sourceImages.has(kernelPath), 'Source calibration requires a libsystem_kernel UUID')
  } catch (error) {
    report.errors.push({ phase: 'source-evidence', error: errorText(error) })
    return report
  }
  report.sourceTrialsComplete = trials.complete === true
  report.sourceScheduledTrials = trials.order?.length ?? null
  report.sourceCompletedTrials = trials.trials.length
  const completedIndices = new Set(trials.trials.map((trial) => trial.index))
  const logNames = await readdir(path.join(source, 'video-export-trials'))
  for (const [index, candidate] of (trials.order || []).entries()) {
    if (completedIndices.has(index)) continue
    assert.match(candidate, /^[a-z0-9-]+$/)
    if (logNames.includes(`${index}-${candidate}.log`))
      trials.trials.push({ index, candidate, verified: false, incomplete: true })
  }
  const sourceHostImages = new Map()
  try {
    const identities = await readFile(
      path.join(source, 'signal-calibration', 'source-system-images.log'),
      'utf8'
    )
    for (const imagePath of [kernelPath, javaScriptCorePath])
      sourceHostImages.set(imagePath, parseDyldUUID(identities, imagePath))
    assert.equal(
      sourceHostImages.get(kernelPath).uuid,
      sourceImages.get(kernelPath).uuid,
      'Source host kernel identity differs from the same-host calibration'
    )
  } catch (error) {
    if (error.code !== 'ENOENT') report.errors.push({ phase: 'source-host-images', error: errorText(error) })
  }
  report.sourceHostSystemImages = [...sourceHostImages.values()]
  report.calibrationKernel = sourceImages.get(kernelPath)
  const identityCache = new Map()
  const currentImage = (imagePath) => {
    if (!identityCache.has(imagePath)) {
      const arch =
        sourceHostImages.get(imagePath)?.arch ||
        sourceImages.get(imagePath)?.arch ||
        sourceImages.get(kernelPath).arch
      assert.match(arch, /^arm64e?$/)
      identityCache.set(imagePath, checkedImage(imagePath, arch, run))
    }
    return identityCache.get(imagePath)
  }
  // Compare kernel identity before invoking atos.
  report.currentKernel = currentImage(kernelPath)
  report.calibrationKernelMatchesCurrent = report.currentKernel.uuid === report.calibrationKernel.uuid
  report.symbolicationCapabilityVerified = false
  if (!report.calibrationKernelMatchesCurrent)
    report.errors.push({
      phase: 'kernel-identity',
      error: 'Current kernel UUID must match source calibration'
    })
  if (report.calibrationKernelMatchesCurrent) {
    try {
      const raised = calibration.results.find((result) => result.mode === 'raise')
      assert.equal(raised?.image?.path, kernelPath, 'Source raise calibration requires the kernel image')
      assert.equal(raised.termination, 'SIGTRAP')
      assert.equal(BigInt(raised.context.sig), 5n)
      const image = { path: kernelPath, base: raised.loaderImage?.base || raised.image.base }
      const symbolication = symbolicateAddress(raised.context.pc, image, report.currentKernel, run)
      report.calibrationSymbolication = { address: raised.context.pc, image, ...symbolication }
      report.symbolicationCapabilityVerified =
        symbolication.resolved && /__pthread_kill/.test(symbolication.tool.stdout)
      assert.equal(
        report.symbolicationCapabilityVerified,
        true,
        'Calibration atos result must resolve the known __pthread_kill frame'
      )
    } catch (error) {
      report.errors.push({ phase: 'calibration-symbolication', error: errorText(error) })
    }
  }
  const symbolicateOwnedAddress = (address) => {
    if (!address.image || address.status === 'recorded-image-unavailable') return
    address.originalTargetUUID ??= null
    const imagePath = address.image.path
    if (!systemImage(imagePath)) {
      address.status = 'original-package-required'
      return
    }
    address.currentImage = currentImage(imagePath)
    address.sourceHostImage = sourceHostImages.get(imagePath) || null
    address.sourceHostImageMatchesCurrent = address.sourceHostImage
      ? address.currentImage.uuid === address.sourceHostImage.uuid
      : null
    address.calibrationImage = sourceImages.get(imagePath) || null
    address.calibrationImageMatchesCurrent = address.calibrationImage
      ? address.currentImage.uuid === address.calibrationImage.uuid
      : null
    address.originalTargetUUIDMatchesCurrent = address.originalTargetUUID
      ? address.currentImage.uuid === address.originalTargetUUID
      : null
    if (!report.calibrationKernelMatchesCurrent) {
      address.status = 'kernel-unverified'
      return
    }
    if (!address.currentImage.uuid) {
      address.status = 'image-unavailable'
      return
    }
    if (
      address.originalTargetUUIDMatchesCurrent === false ||
      address.calibrationImageMatchesCurrent === false ||
      address.sourceHostImageMatchesCurrent === false
    ) {
      address.status = 'image-mismatch'
      return
    }
    const symbolication = symbolicateAddress(address.address, address.image, address.currentImage, run)
    address.symbolication = symbolication.tool
    address.status = symbolication.resolved ? 'symbolicated' : 'unresolved'
  }
  for (const trial of trials.trials) {
    const result = {
      index: trial.index,
      candidate: trial.candidate,
      sourceVerified: trial.verified === true,
      sourceTrialComplete: trial.incomplete !== true
    }
    report.trials.push(result)
    try {
      assert.ok(Number.isSafeInteger(trial.index) && trial.index >= 0)
      assert.match(trial.candidate, /^[a-z0-9-]+$/)
      const filename = `${trial.index}-${trial.candidate}.log`
      result.log = path.join('video-export-trials', filename)
      const log = await readFile(path.join(source, result.log), 'utf8')
      report.trialsInspected++
      report.markerCount += log.split(/\r?\n/).filter((line) => line.startsWith(marker)).length
      const ownedTraps = ownedTrialDiagnostics(log).filter((record) => record.host.signal === 'SIGTRAP')
      report.ownedHostSIGTRAPCount += new Set(ownedTraps.map((record) => record.host.pid)).size
      const observationPath = path.join(
        'video-export-trials',
        `${trial.index}-post-signal`,
        'host-observation.json'
      )
      let postObservation
      try {
        postObservation = JSON.parse(await readFile(path.join(source, observationPath), 'utf8'))
        result.postSignalObservation = observationPath
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      const signal = inspectTrialSignal(log, { postObservation })
      if (!signal) {
        result.status = 'no-owned-host-sigtrap'
        continue
      }
      Object.assign(result, signal)
      result.status = 'owned-host-sigtrap'
      if (result.postSignalCapture) {
        for (const frame of result.postSignalCapture.frames) {
          symbolicateOwnedAddress(frame)
          if (frame.previousInstruction) symbolicateOwnedAddress(frame.previousInstruction)
        }
        for (const [name, source] of [
          ['pc', 'original-pc'],
          ['lr', 'original-lr'],
          ['lrPreviousInstruction', 'original-lr']
        ]) {
          const frame = result.postSignalCapture.frames.find((frame) => frame.source === source)
          const address = name === 'lrPreviousInstruction' ? frame?.previousInstruction : frame
          if (address) result.addresses[name] = { ...address }
          else result.addresses[name].status = 'capture-frame-unavailable'
        }
        result.originalTargetUUIDsRecorded = result.postSignalCapture.frames.some(
          (frame) => frame.originalTargetUUID
        )
        report.originalTargetUUIDsRecorded ||= result.originalTargetUUIDsRecorded
      } else {
        result.originalTargetUUIDsRecorded = false
        for (const address of Object.values(result.addresses)) symbolicateOwnedAddress(address)
      }
    } catch (error) {
      result.status = 'evidence-error'
      result.error = errorText(error)
      report.errors.push({ phase: 'trial-evidence', index: trial.index, error: result.error })
    }
  }
  report.status = report.errors.length ? 'completed-with-evidence-errors' : 'complete'
  report.outcome =
    report.ownedHostSIGTRAPCount === 0
      ? report.errors.length
        ? 'evidence-incomplete'
        : 'zero-owned-host-sigtrap'
      : 'owned-host-sigtrap'
  return report
}

async function main() {
  const [artifactRoot, output] = process.argv.slice(2)
  assert.ok(artifactRoot && output, 'Pass downloaded artifact root and output JSON path')
  let report
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    report = {
      status: 'native-host-required',
      platform: process.platform,
      arch: process.arch,
      error: 'Post-symbolication requires macOS ARM64 Apple tools.'
    }
  } else report = await symbolicateSignalTrials(artifactRoot)
  await mkdir(path.dirname(path.resolve(output)), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(
    JSON.stringify({
      status: report.status,
      ownedHostSIGTRAPCount: report.ownedHostSIGTRAPCount ?? null,
      output: path.resolve(output)
    })
  )
  if (report.status !== 'complete') process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.stack || error)
    process.exitCode = 1
  })
