import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

assert.equal(process.platform, 'darwin', 'Host trace calibration requires macOS')
assert.equal(process.arch, 'arm64', 'Host trace calibration requires ARM64')
const directory = path.resolve('build/signal-calibration')
const calibration = JSON.parse(await readFile(path.join(directory, 'calibration.json'), 'utf8'))
assert.equal(calibration.verified, true)
const known = calibration.results.find((result) => result.mode === 'brk0')
const probe = path.join(directory, 'signal-context-probe')
const library = path.join(directory, 'signal-context-native.dylib')
const script = path.resolve('scripts/fixtures/host_trace.py')
const marker = 'OpenLR host trace calibration '
const commands = [
  `target create ${JSON.stringify(probe)}`,
  `settings set target.run-args ${JSON.stringify(library)} brk0`,
  'settings set target.env-vars GODEBUG=asyncpreemptoff=1',
  `command script import ${JSON.stringify(script)}`,
  'run',
  `script import json; p=lldb.debugger.GetSelectedTarget().GetProcess(); print(${JSON.stringify(marker)} + json.dumps(dict(pid=p.GetProcessID(), **__import__('host_trace').fault(p))))`,
  'process kill'
]
const args = ['lldb', '--batch', '--no-lldbinit', ...commands.flatMap((command) => ['-o', command])]
const result = spawnSync('xcrun', args, {
  encoding: 'utf8',
  timeout: 45_000,
  maxBuffer: 1024 * 1024,
  shell: false
})
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'host-trace.stdout.log'), result.stdout || '')
await writeFile(path.join(directory, 'host-trace.stderr.log'), result.stderr || '')
const report = {
  status: 'incomplete',
  exitCode: result.status,
  signal: result.signal,
  error: result.error?.message || null,
  commands
}
try {
  assert.equal(result.status, 0, 'LLDB calibration commands must complete successfully')
  assert.equal(result.error, undefined, 'LLDB calibration must finish within the execution bound')
  const lines = (result.stdout || '').split(/\r?\n/).filter((line) => line.startsWith(marker))
  assert.equal(lines.length, 1, 'Expected exactly one stopped-thread calibration record')
  const record = JSON.parse(lines[0].slice(marker.length))
  report.record = record
  assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0)
  assert.ok(record.signal === 5 || record.exception === 'EXC_BREAKPOINT')
  assert.equal(record.frames[0].symbol, 'openlr_brk0')
  assert.equal(record.frames[0].uuid.replaceAll('-', '').toLowerCase(), known.image.uuid)
  const offset = BigInt(known.context.pc) - BigInt(known.image.base)
  assert.equal(BigInt(record.frames[0].imageOffset), offset)
  for (const register of ['pc', 'lr', 'fp', 'sp', 'x0', 'x19'])
    assert.match(record.registers[register], /^0x[0-9a-f]+$/)
  assert.equal(BigInt(record.registers.pc) & 3n, 0n)
  report.status = 'passed'
} catch (error) {
  report.error = error.message
  process.exitCode = 1
}
await writeFile(path.join(directory, 'host-trace.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ hostTraceCalibration: report.status, error: report.error }))
