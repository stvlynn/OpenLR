import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runOwnedDebugger } from './post-signal-observer.mjs'

const jscPath = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/JavaScriptCore'
const capturedUUID = 'A6079469BB2538B3B603D712B7DBB43D'
const marker = 'OpenLR signal code inspection '
const reader = fileURLToPath(new URL('./fixtures/signal_code_trace.py', import.meta.url))
const functions = [
  /^pas_panic_on_out_of_memory_error$/,
  /^pas_allocation_result_crash_on_error$/,
  /^bmalloc_allocate_impl_casual_case$/,
  /^JSC::growBuffer\(/,
  /^JSC::MachineThreads::gatherConservativeRoots\(/
]
const uuidKey = (value) =>
  String(value || '')
    .replaceAll('-', '')
    .toUpperCase()

export function selectSignalCodePoints(reports) {
  const points = new Map(),
    found = new Set(),
    sources = []
  for (const { trial, observation } of reports) {
    if (!observation.faultObserved || observation.hostExit?.signal !== 'SIGTRAP') continue
    const capture = observation.capture?.record
    assert.ok(
      capture && ['captured', 'partial'].includes(capture.status),
      'Expected actual post-fault frames'
    )
    assert.equal(capture.pid, observation.pid)
    assert.equal(capture.sessionComplete, true)
    let selected = 0
    for (const frame of capture.frames) {
      const match = functions.findIndex((pattern) => pattern.test(frame.symbol || ''))
      if (match < 0) continue
      assert.equal(frame.status, 'mapped')
      assert.equal(frame.image, 'JavaScriptCore')
      assert.equal(
        uuidKey(frame.uuid),
        capturedUUID,
        'Captured JSC UUID differs from this exact-code investigation'
      )
      assert.ok(
        Number.isSafeInteger(frame.imageOffset) && frame.imageOffset >= 0 && frame.imageOffset % 4 === 0
      )
      for (const value of [frame.address, frame.base]) assert.match(value, /^0x[0-9a-fA-F]{1,16}$/)
      assert.equal(BigInt(frame.address) - BigInt(frame.base), BigInt(frame.imageOffset))
      found.add(match)
      selected++
      const add = (offset, returnSite) => {
        const key = '0x' + offset.toString(16)
        const evidence = {
          trial,
          frame: frame.source,
          symbol: frame.symbol,
          capturedOffset: '0x' + frame.imageOffset.toString(16),
          returnSite
        }
        if (!points.has(key)) points.set(key, { offset: key, sources: [] })
        assert.ok(points.get(key).sources.length < 64, 'Code point source evidence exceeds its bound')
        points.get(key).sources.push(evidence)
      }
      add(frame.imageOffset, false)
      // Saved LR/frame return addresses point past the call; retain both locations.
      if (frame.source !== 'original-pc' && frame.imageOffset >= 4) add(frame.imageOffset - 4, true)
    }
    if (selected)
      sources.push({
        trial,
        pid: observation.pid,
        frameCount: capture.frames.length,
        stopReason: capture.stopReason
      })
  }
  assert.equal(
    found.size,
    functions.length,
    'Actual capture must contain every selected allocator and stack-gather function'
  )
  assert.ok(points.size > 0 && points.size <= 16, 'Selected code points exceed their diagnostic bound')
  return { uuid: capturedUUID, points: [...points.values()], sources }
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

async function ownedPath(root, candidate) {
  const resolved = await realpath(candidate)
  const relative = path.relative(root, resolved)
  assert.ok(
    relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative),
    'Fixture evidence must stay inside its source artifact'
  )
  return resolved
}

async function readObservation(root, candidate) {
  const file = await ownedPath(root, candidate)
  const metadata = await stat(file)
  assert.ok(
    metadata.isFile() && metadata.size <= 4 * 1024 * 1024,
    'Post-fault evidence exceeds its diagnostic bound'
  )
  return JSON.parse(await readFile(file, 'utf8'))
}

function launchFixture(executable, library) {
  const child = spawn(executable, [library, 'brk0'], {
    env: { ...process.env, OPENLR_SIGNAL_PROBE_WAIT: '1', DYLD_INSERT_LIBRARIES: jscPath },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const output = { stdout: '', stderr: '', error: null, closed: null, truncated: false }
  for (const stream of ['stdout', 'stderr'])
    child[stream].setEncoding('utf8').on('data', (chunk) => {
      output.truncated ||= output[stream].length + chunk.length > 2 * 1024 * 1024
      output[stream] = (output[stream] + chunk).slice(0, 2 * 1024 * 1024)
    })
  child.once('error', (error) => (output.error = { name: error.name, message: error.message }))
  output.completion = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      output.closed = { code, signal }
      resolve(output.closed)
    })
  )
  return { child, output }
}

async function waitForController(owner) {
  const deadline = performance.now() + 10_000
  for (;;) {
    assert.equal(owner.output.error, null)
    assert.equal(owner.output.closed, null, 'Owned waiting fixture exited before inspection')
    assert.equal(owner.output.truncated, false)
    const complete = owner.output.stdout.slice(0, owner.output.stdout.lastIndexOf('\n') + 1)
    const records = complete
      .split(/\r?\n/)
      .filter((line) => line.startsWith('OpenLR signal fixture '))
      .map((line) => JSON.parse(line.slice('OpenLR signal fixture '.length)))
      .filter((record) => record.kind === 'controller-ready')
    if (records.length) {
      assert.equal(records.length, 1)
      assert.equal(records[0].pid, owner.child.pid)
      return records[0]
    }
    assert.ok(performance.now() < deadline, 'Owned fixture did not reach its stdin controller wait')
    await delay(20)
  }
}

async function terminateFixture(owner, record) {
  record.signalsSent = []
  record.forcedKill = false
  if (!owner.output.closed) {
    record.signalsSent.push({ signal: 'SIGTERM', sent: owner.child.kill('SIGTERM') })
    try {
      await within(owner.output.completion, 5000, 'Owned inspection fixture did not terminate')
    } catch {
      record.forcedKill = true
      record.signalsSent.push({ signal: 'SIGKILL', sent: owner.child.kill('SIGKILL') })
      await within(owner.output.completion, 5000, 'Owned inspection fixture cleanup remains unconfirmed')
    }
  }
  record.exit = owner.output.closed
  record.cleanupConfirmed = Boolean(owner.output.closed)
  record.expectedTermination = Boolean(
    ['SIGTERM', 'SIGKILL'].includes(owner.output.closed?.signal) &&
    record.signalsSent.some(({ signal, sent }) => signal === owner.output.closed.signal && sent === true)
  )
  record.error = owner.output.error
  record.truncated = owner.output.truncated
}

export async function inspectSignalCode(sourceRoot, outputDirectory) {
  const directory = path.resolve(outputDirectory)
  await mkdir(directory, { recursive: true })
  const report = {
    verified: false,
    scope: 'UUID-matched system JSC code only; no allocation or register interpretation',
    fixture: {},
    debugger: null
  }
  let fixture
  try {
    assert.equal(process.platform, 'darwin', 'Loaded system JSC code inspection requires macOS')
    assert.equal(process.arch, 'arm64', 'Loaded system JSC code inspection requires ARM64')
    const root = await realpath(path.resolve(sourceRoot))
    const entries = await readdir(path.join(root, 'video-export-trials'), { withFileTypes: true })
    const candidates = entries.filter((entry) => entry.isDirectory() && /^\d+-post-signal$/.test(entry.name))
    assert.ok(candidates.length <= 64, 'Trial evidence directory count exceeds its diagnostic bound')
    const reports = []
    for (const entry of candidates)
      reports.push({
        trial: Number(entry.name.split('-')[0]),
        observation: await readObservation(
          root,
          path.join(root, 'video-export-trials', entry.name, 'host-observation.json')
        )
      })
    report.selection = selectSignalCodePoints(reports)
    const executable = await ownedPath(root, path.join(root, 'signal-calibration', 'signal-context-probe'))
    const library = await ownedPath(
      root,
      path.join(root, 'signal-calibration', 'signal-context-native.dylib')
    )
    assert.ok(
      (await stat(executable)).isFile() && (await stat(library)).isFile(),
      'Expected the prebuilt fixture executable and dylib files'
    )
    await chmod(executable, 0o755)
    fixture = launchFixture(executable, library)
    assert.ok(Number.isSafeInteger(fixture.child.pid) && fixture.child.pid > 0)
    report.fixture.pid = fixture.child.pid
    report.fixture.controller = await waitForController(fixture)
    const nonce = randomUUID()
    const observation = {
      record: null,
      debuggerExit: null,
      cleanupConfirmed: false,
      cleanupError: null,
      requestPath: path.join(directory, 'signal-code.request.json'),
      stdoutPath: path.join(directory, 'signal-code.debugger.stdout.log'),
      stderrPath: path.join(directory, 'signal-code.debugger.stderr.log')
    }
    report.debugger = observation
    await writeFile(
      observation.requestPath,
      JSON.stringify({ pid: fixture.child.pid, nonce, ...report.selection }, null, 2) + '\n'
    )
    await runOwnedDebugger({
      observation,
      args: [
        'lldb',
        '--batch',
        '--no-lldbinit',
        '-o',
        `command script import ${JSON.stringify(reader)}`,
        '-o',
        `openlr-inspect-signal-code ${JSON.stringify(observation.requestPath)}`
      ],
      inspect(output) {
        const records = output.stdout
          .split(/\r?\n/)
          .filter((line) => line.startsWith(marker))
          .map((line) => JSON.parse(line.slice(marker.length)))
        observation.records = records
        if (records.length === 1) observation.record = records[0]
        assert.equal(records.length, 1, 'Expected one code inspection record')
        assert.equal(observation.record.pid, fixture.child.pid)
        assert.equal(observation.record.nonce, nonce)
        assert.equal(observation.record.uuidMatched, true)
        assert.equal(uuidKey(observation.record.moduleUUID), report.selection.uuid)
        assert.equal(observation.record.status, 'complete', 'All selected code points must be inspected')
        assert.equal(
          observation.record.detachSuccess,
          true,
          'Inspector must detach normally from its waiting fixture'
        )
      }
    })
    report.inspectionComplete = true
  } catch (error) {
    report.error = { name: error.name, message: error.message }
  } finally {
    if (fixture) {
      try {
        await terminateFixture(fixture, report.fixture)
      } catch (error) {
        report.fixture.cleanupConfirmed = false
        report.fixture.cleanupError = { name: error.name, message: error.message }
      }
      try {
        await writeFile(path.join(directory, 'fixture.stdout.log'), fixture.output.stdout)
        await writeFile(path.join(directory, 'fixture.stderr.log'), fixture.output.stderr)
      } catch (error) {
        report.fixture.persistenceError = { name: error.name, message: error.message }
      }
    }
    report.verified = Boolean(
      report.inspectionComplete &&
      report.debugger?.cleanupConfirmed &&
      report.fixture.cleanupConfirmed &&
      report.fixture.expectedTermination &&
      !report.fixture.error &&
      !report.fixture.truncated &&
      !report.fixture.persistenceError
    )
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  }
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, directory] = process.argv.slice(2)
  assert.ok(
    source && directory && process.argv.length === 4,
    'Usage: node scripts/inspect-signal-code.mjs SOURCE_ARTIFACT_ROOT OUTPUT_DIRECTORY'
  )
  const report = await inspectSignalCode(source, directory)
  console.log(
    JSON.stringify({
      signalCodeInspection: report.verified ? 'passed' : 'failed',
      error: report.error?.name || null
    })
  )
  if (!report.verified) process.exitCode = 1
}
