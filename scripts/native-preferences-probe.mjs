import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProbeHost, ProbeHostUnconfirmedError, profileEnvironment } from './native-probe-host.mjs'

export const preferenceTrials = [
  'local-storage',
  'indexeddb-strict',
  'indexeddb-strict',
  'local-storage',
  'local-storage',
  'indexeddb-strict',
  'indexeddb-strict',
  'local-storage'
].map((candidate, index, order) => ({
  candidate,
  value: order.slice(0, index).filter((name) => name === candidate).length % 2 === 1
}))

export function checkPreferenceReport(report, expected) {
  for (const key of ['candidate', 'phase', 'value']) assert.equal(report[key], expected[key])
  if (report.error) return { ...expected, errorName: String(report.error.name), verified: false }
  assert.ok(Number.isFinite(report.elapsedMs) && report.elapsedMs >= 0)
  const valid = (value) =>
    value &&
    Object.keys(value).length === 4 &&
    ['autoAdvance', 'filenames', 'extensions', 'shortcuts'].every((key) => typeof value[key] === 'boolean')
  assert.ok(valid(report.before) && valid(report.after), 'Invalid preference object')
  assert.ok(report.stored === null || valid(report.stored), 'Invalid persisted record')
  const desired = { autoAdvance: false, filenames: expected.value, extensions: true, shortcuts: true }
  const matches = (value) =>
    value !== null && Object.keys(desired).every((key) => value[key] === desired[key])
  const strict =
    expected.candidate !== 'indexeddb-strict' || expected.phase !== 'write' || report.durability === 'strict'
  return {
    ...expected,
    before: report.before,
    after: report.after,
    stored: report.stored,
    durability: report.durability,
    elapsedMs: report.elapsedMs,
    verified: matches(report.after) && matches(report.stored) && strict
  }
}

async function main(executable, output) {
  if (!executable || !output) throw Error('Pass a built preferences probe and output JSON path')
  const parent = await realpath(tmpdir()),
    root = await mkdtemp(path.join(parent, 'olr-pref-'))
  const env = profileEnvironment(root),
    trials = []
  let retain = false
  try {
    for (const [index, trial] of preferenceTrials.entries()) {
      const result = { index, ...trial, phases: [] }
      trials.push(result)
      for (const phase of ['write', 'read']) {
        const reportPath = path.join(root, `${index}-${phase}.json`)
        const started = performance.now()
        await runProbeHost(
          path.resolve(executable),
          [path.resolve('web'), reportPath, trial.candidate, phase, String(trial.value)],
          { env }
        )
        result.phases.push({
          ...checkPreferenceReport(JSON.parse(await readFile(reportPath, 'utf8')), { ...trial, phase }),
          hostMs: performance.now() - started
        })
      }
      result.verified = result.phases.every((phase) => phase.verified)
      console.log(JSON.stringify(result))
    }
  } catch (error) {
    retain = error instanceof ProbeHostUnconfirmedError
    throw error
  } finally {
    await writeFile(
      output,
      JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          trials,
          complete:
            trials.length === preferenceTrials.length && trials.every((trial) => trial.phases.length === 2),
          verified: trials.length === preferenceTrials.length && trials.every((trial) => trial.verified)
        },
        null,
        2
      )
    )
    if (retain) console.error('Probe host exit unconfirmed; retaining its temporary profile')
    else {
      const resolved = await realpath(root)
      assert.equal(path.dirname(resolved), parent)
      assert.ok(path.basename(resolved).startsWith('olr-pref-'))
      await rm(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
    }
  }
  if (trials.some((trial) => !trial.verified))
    throw Error('Preference persistence comparison retained failed trials')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(...process.argv.slice(2))
