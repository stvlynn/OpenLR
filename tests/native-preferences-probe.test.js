import assert from 'node:assert/strict'
import test from 'node:test'
import { checkPreferenceReport, preferenceTrials } from '../scripts/native-preferences-probe.mjs'

test('preference restart evidence rejects missing records, stale values and non-strict acknowledgments', () => {
  const expected = { candidate: 'indexeddb-strict', phase: 'write', value: true }
  const values = { autoAdvance: false, filenames: true, extensions: true, shortcuts: true }
  const report = {
    ...expected,
    before: values,
    after: values,
    stored: values,
    durability: 'strict',
    elapsedMs: 1
  }
  assert.equal(checkPreferenceReport(report, expected).verified, true)
  assert.equal(checkPreferenceReport({ ...report, stored: null }, expected).verified, false)
  assert.equal(
    checkPreferenceReport({ ...report, stored: { ...values, filenames: false } }, expected).verified,
    false
  )
  assert.equal(checkPreferenceReport({ ...report, durability: 'relaxed' }, expected).verified, false)
  assert.equal(
    checkPreferenceReport({ ...report, error: { name: 'UnknownError' } }, expected).verified,
    false
  )
  assert.throws(() => checkPreferenceReport({ ...report, phase: 'read' }, expected))
  const read = { ...expected, phase: 'read' }
  assert.equal(checkPreferenceReport({ ...report, ...read, stored: null }, read).verified, false)
})

test('paired preference trials change each backend value on every write', () => {
  for (const candidate of ['local-storage', 'indexeddb-strict'])
    assert.deepEqual(
      preferenceTrials.filter((trial) => trial.candidate === candidate).map((trial) => trial.value),
      [false, true, false, true]
    )
})
