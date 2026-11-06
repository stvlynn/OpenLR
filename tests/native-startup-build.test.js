import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { withDiagnosticBuildStage } from '../scripts/native-startup-build.mjs'

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'openlr-startup-build-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('diagnostic scratch removes only its build copy and preserves a failing build error', (t) => {
  const root = fixture(t),
    workspace = path.join(root, '.workspace')
  mkdirSync(workspace)
  writeFileSync(path.join(workspace, 'existing.txt'), 'keep')
  const failure = Error('controlled build error')
  assert.throws(
    () =>
      withDiagnosticBuildStage(root, (scratch) => {
        writeFileSync(path.join(scratch, 'copied-dependency.go'), '')
        throw failure
      }),
    (error) => error === failure
  )
  assert.equal(
    withDiagnosticBuildStage(root, () => 'built'),
    'built'
  )
  assert.deepEqual(readdirSync(workspace), ['existing.txt'])
})

test('diagnostic staging rejects a directory redirected outside its workspace', (t) => {
  const root = fixture(t),
    elsewhere = fixture(t)
  writeFileSync(path.join(elsewhere, 'existing.txt'), 'keep')
  symlinkSync(elsewhere, path.join(root, '.workspace'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => withDiagnosticBuildStage(root, () => assert.fail()), /Expected private staging/)
  assert.deepEqual(readdirSync(elsewhere), ['existing.txt'])
})
