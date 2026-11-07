import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { finished } from 'node:stream/promises'

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const output = path.resolve(root, process.argv[2] || 'build/scheme-bridge-probe')
if (!output.startsWith(root + path.sep)) throw Error('Probe output must remain inside this workspace')
if (process.platform !== 'darwin') throw Error('Run the scheme bridge probe on actual macOS')
const resultDirectory = path.join(output, 'run')
mkdirSync(resultDirectory, { recursive: true })
const stdout = createWriteStream(path.join(resultDirectory, 'stdout.log'), { flags: 'wx' })
const stderr = createWriteStream(path.join(resultDirectory, 'stderr.log'), { flags: 'wx' })
const logCompletion = Promise.allSettled([finished(stdout), finished(stderr)])
const started = new Date()
const owner = {
  executable: path.join(output, 'scheme-bridge-probe'),
  started: started.toISOString(),
  timeoutMs: 90000,
  pid: null,
  processGroup: null,
  forced: false,
  exitConfirmed: false,
  limitation:
    'Owns its spawned host process group; launchd-owned WebKit processes are outside this ownership record'
}
let deadline
try {
  // A new group makes timeout cleanup target this fixture's processes only.
  const child = spawn(owner.executable, [resultDirectory], {
    cwd: root,
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  owner.pid = child.pid ?? null
  owner.processGroup = child.pid ?? null
  child.stdout.pipe(stdout)
  child.stderr.pipe(stderr)
  deadline = setTimeout(() => {
    owner.forced = true
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') owner.killError = error.message
    }
  }, owner.timeoutMs)
  const [code, signal] = await once(child, 'close')
  owner.exitConfirmed = true
  owner.exitCode = code
  owner.signal = signal
  if (owner.forced) throw Error('Scheme bridge probe exceeded its deadline; owned process group was killed')
  if (code !== 0) throw Error(`Scheme bridge host failed (${code ?? signal})`)
  const report = JSON.parse(readFileSync(path.join(resultDirectory, 'report.json'), 'utf8'))
  const expected = [
    'renderer/unicodeLargeExact',
    'renderer/concurrentCalls',
    'renderer/eventUnicode',
    'renderer/channelOrderAndBackpressure',
    'renderer/nativeScriptMessageHandlerAbsent',
    'renderer/getRejected',
    'renderer/forgedCapabilityRejected',
    'renderer/abortedFetch',
    'renderer/childHasNoBridge',
    'renderer/childForgeryRejected',
    'eval/expression',
    'eval/statements',
    'eval/unicode',
    'eval/promise',
    'eval/rejected-promise',
    'eval/native-syntax-error',
    'eval/runtime-error',
    'eval/runtime-syntax-single-execution',
    'eval/runtime-syntax-counter',
    'eval/statements-single-execution',
    'eval/duplicate-reply',
    'eval/duplicate-rejected',
    'eval/transport-syntax-no-fallback',
    'eval/transport-single-counter',
    'eval/context-cancellation',
    'eval/late-reply-does-not-complete-next',
    'navigation/same-document',
    'navigation/prevented-live-page',
    'navigation/prevented-observed',
    'navigation/provisional-failure-observed',
    'navigation/failed-provisional-live-page',
    'navigation/save-old-envelope',
    'navigation/start-page-bound-call',
    'navigation/eval-before-commit',
    'navigation/new-page-ready',
    'navigation/page-context-canceled',
    'navigation/pending-eval-canceled',
    'navigation/old-envelope-rejected',
    'navigation/new-page-normal-call',
    'transport/reserved-endpoint-owned'
  ]
  const missing = expected.filter((name) => report.checks?.[name] !== true)
  owner.checksPassed = Object.values(report.checks || {}).filter((value) => value === true).length
  owner.expectedChecks = expected.length
  if (report.passed !== true || missing.length)
    throw Error(`Scheme bridge assertions failed: ${missing.join(', ') || report.errors?.join('; ')}`)
  console.log(
    `Scheme bridge diagnostic completed: ${expected.length} required assertions; host exit confirmed`
  )
} catch (error) {
  owner.error = error.message
  process.exitCode = 1
  console.error(error.message)
} finally {
  clearTimeout(deadline)
  stdout.end()
  stderr.end()
  const logResults = await logCompletion
  for (const result of logResults) {
    if (result.status === 'rejected') {
      owner.logError = result.reason.message
      process.exitCode = 1
    }
  }
  owner.finished = new Date().toISOString()
  owner.elapsedMs = Date.now() - started.getTime()
  writeFileSync(path.join(resultDirectory, 'process.json'), JSON.stringify(owner, null, 2) + '\n')
}
