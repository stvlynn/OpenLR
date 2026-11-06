import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [app, destination] = process.argv.slice(2)
assert.ok(app && destination, 'Pass the application and report directory')
const ordinary = 'scripts/native-smoke.mjs'
const traced = 'scripts/.native-still-trace.mjs'
const source = await readFile(ordinary, 'utf8')
const start = '  const sharpenInput = makePng({'
const end = '  const batchDirectory = path.join(root, \'batch-exports\'),'
assert.equal(source.split(start).length, 2)
assert.equal(source.split(end).length, 2)
const instrumented =
  "import { withHostCrashTrace } from './native-crash-trace.mjs'\n" +
  source
    .replace(start, '  await withHostCrashTrace({ root, pid: host.pid }, async () => {\n' + start)
    .replace(end, '  })\n' + end)
await writeFile(traced, instrumented, { flag: 'wx' })
execFileSync(process.execPath, ['--check', traced])

await mkdir(destination, { recursive: true })
const order = ['ordinary', 'traced', 'traced', 'ordinary']
const trials = []
for (const [index, mode] of order.entries()) {
  const name = `${index}-${mode}.log`
  const output = await open(path.join(destination, name), 'wx')
  const started = performance.now()
  let code, signal
  try {
    const child = spawn(process.execPath, [mode === 'ordinary' ? ordinary : traced, path.resolve(app)], {
      env: { ...process.env, OPENLR_DIAGNOSTICS: '1' },
      stdio: ['ignore', output.fd, output.fd]
    })
    ;[code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve([code, signal]))
    })
  } finally {
    await output.close()
  }
  const log = await readFile(path.join(destination, name), 'utf8')
  const completed = log.includes('Native GUI/CLI passed RAW, editing, PNG preview, original bytes')
  const verified = code === 0 && signal === null && completed
  const cleanup = signal === null && !log.includes('Native cleanup failed:')
  const trial = { index, mode, code, signal, verified, cleanup, elapsedMs: Math.round(performance.now() - started) }
  trials.push(trial)
  console.log(JSON.stringify(trial))
  await writeFile(
    path.join(destination, 'report.json'),
    JSON.stringify({ platform: process.platform, arch: process.arch, order, trials }, null, 2)
  )
  assert.ok(cleanup, 'Stop the schedule when cleanup is unconfirmed')
}
assert.ok(trials.every(({ verified }) => verified), 'The still-image schedule retained failed trials')
