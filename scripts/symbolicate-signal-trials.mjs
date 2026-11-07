import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mappedSignalImage, parseSignalContext } from './calibrate-signal-context.mjs'

const marker = 'OpenLR forwarded signal sig/code/pc/lr/sp '
const diagnosticPrefixes = ['Native workflow failure diagnostics: ', 'Native startup diagnostics: ']
const kernelPath = '/usr/lib/system/libsystem_kernel.dylib'
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const normalizeUUID = (uuid) => uuid.replaceAll('-', '').toLowerCase()
const errorText = (error) => String(error?.message || error).slice(0, 2048)

// Associate a runtime marker with one harness-owned SIGTRAP host.
function ownedTrialDiagnostics(log) {
  const diagnostics = []
  for (const line of log.split(/\r?\n/)) {
    const prefix = diagnosticPrefixes.find((prefix) => line.startsWith(prefix))
    if (!prefix) continue
    const record = JSON.parse(line.slice(prefix.length))
    assert.ok(
      Number.isSafeInteger(record.host?.pid) && record.host.pid > 0,
      'Failure diagnostics must identify a positive owned host PID'
    )
    diagnostics.push(record)
  }
  return diagnostics
}

export function inspectTrialSignal(log) {
  const diagnostics = ownedTrialDiagnostics(log)
  const traps = diagnostics.filter((record) => record.host.signal === 'SIGTRAP')
  const markerPresent = log.split(/\r?\n/).some((line) => line.startsWith(marker))
  if (!traps.length) {
    assert.equal(markerPresent, false, 'Original marker requires an owned SIGTRAP host exit')
    return null
  }
  const pids = [...new Set(diagnostics.map((record) => record.host.pid))]
  assert.equal(pids.length, 1, 'Multiple owned host PIDs make the PID-free runtime marker ambiguous')
  const context = parseSignalContext(log)
  assert.equal(BigInt(context.sig), 5n, 'Original marker signal differs from the owned SIGTRAP exit')
  const pid = pids[0]
  const addresses = Object.fromEntries(
    ['pc', 'lr'].map((register) => {
      const address = context[register]
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
  return { pid, host: traps.at(-1).host, context, addresses }
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
      'Original loader maps establish owned PID, module and offset. Original target UUIDs are absent. Calibration UUIDs identify calibration-process system images; current-host symbolication uses the recorded identity comparisons.',
    originalTargetUUIDsRecorded: false,
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
  report.calibrationKernel = sourceImages.get(kernelPath)
  const identityCache = new Map()
  const currentImage = (imagePath) => {
    if (!identityCache.has(imagePath)) {
      const arch = sourceImages.get(imagePath)?.arch || sourceImages.get(kernelPath).arch
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
  for (const trial of trials.trials) {
    const result = { index: trial.index, candidate: trial.candidate, sourceVerified: trial.verified === true }
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
      const signal = inspectTrialSignal(log)
      if (!signal) {
        result.status = 'no-owned-host-sigtrap'
        continue
      }
      Object.assign(result, signal)
      result.status = 'owned-host-sigtrap'
      for (const address of Object.values(result.addresses)) {
        if (!address.image) continue
        address.originalTargetUUID = null
        const imagePath = address.image.path
        if (!imagePath.startsWith('/usr/lib/') && !imagePath.startsWith('/System/Library/')) {
          address.status = 'original-package-required'
          continue
        }
        address.currentImage = currentImage(imagePath)
        address.calibrationImage = sourceImages.get(imagePath) || null
        address.calibrationImageMatchesCurrent = address.calibrationImage
          ? address.currentImage.uuid === address.calibrationImage.uuid
          : null
        if (!report.calibrationKernelMatchesCurrent) {
          address.status = 'kernel-unverified'
          continue
        }
        if (!address.currentImage.uuid) {
          address.status = 'image-unavailable'
          continue
        }
        if (address.calibrationImageMatchesCurrent === false) {
          address.status = 'image-mismatch'
          continue
        }
        const symbolication = symbolicateAddress(address.address, address.image, address.currentImage, run)
        address.symbolication = symbolication.tool
        address.status = symbolication.resolved ? 'symbolicated' : 'unresolved'
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
