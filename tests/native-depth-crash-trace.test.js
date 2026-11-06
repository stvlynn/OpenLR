import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { withDepthCrashTrace } from '../scripts/native-depth-crash-trace.mjs'

const pid = 123
const prefix = 'OpenLR depth LLDB '

async function controlledTrace(t, body) {
  const temporary = await realpath(os.tmpdir())
  const directoryPrefix = 'openlr-depth-trace-'
  const root = await mkdtemp(path.join(temporary, directoryPrefix))
  t.after(async () => {
    const cleanup = await realpath(root)
    assert.equal(path.dirname(cleanup), temporary)
    assert.ok(path.basename(cleanup).startsWith(directoryPrefix))
    await rm(cleanup, { recursive: true, force: true })
  })
  const records = []
  let launches = 0
  const launch = (host, marker) => {
    launches++
    assert.equal(host, pid)
    assert.equal(path.dirname(marker), root)
    return spawn(
      process.execPath,
      [
        '-e',
        `const { existsSync } = require('node:fs')
        const [pid, marker] = process.argv.slice(1)
        const emit = (phase, host = Number(pid)) =>
          console.log(${JSON.stringify(prefix)} + JSON.stringify({ pid: host, phase }))
        ${body}`,
        String(host),
        marker
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
  }
  return {
    run: async (operation) => {
      try {
        return await withDepthCrashTrace({ root, pid }, operation, {
          launch,
          log: (line) => records.push(line)
        })
      } finally {
        assert.equal(launches, 1)
        assert.equal(await readFile(path.join(root, 'depth-trace-finished'), 'utf8'), '')
      }
    },
    phases: () => records.map((line) => JSON.parse(line.slice(prefix.length)).phase)
  }
}

test('runs the depth operation once after its owned debugger resumes and waits for detach', async (t) => {
  const trace = await controlledTrace(
    t,
    `console.log('ignore raw debugger output')
    emit('running', 999)
    emit('running')
    const timer = setInterval(() => {
      if (!existsSync(marker)) return
      clearInterval(timer)
      emit('detached')
    }, 5)`
  )
  let calls = 0
  assert.equal(
    await trace.run(async () => {
      calls++
      assert.deepEqual(trace.phases(), ['running'])
      return 'depth result'
    }),
    'depth result'
  )
  assert.equal(calls, 1)
  assert.deepEqual(trace.phases(), ['running', 'detached'])
})

test('keeps the original command error when the debugger captures a trap', async (t) => {
  const trace = await controlledTrace(t, "emit('running'); emit('fault')")
  const original = new Error('original recipe read failed')
  await assert.rejects(
    trace.run(async () => {
      throw original
    }),
    (error) => error === original
  )
  assert.deepEqual(trace.phases(), ['running', 'fault'])
})

test('reports unavailable attach and does not submit the depth operation', async (t) => {
  const trace = await controlledTrace(t, "emit('attach-failed')")
  let calls = 0
  await assert.rejects(
    trace.run(async () => calls++),
    /could not attach and resume/
  )
  assert.equal(calls, 0)
  assert.deepEqual(trace.phases(), ['attach-failed'])
})

test('rejects a successful command result when the debugger lost the inferior', async (t) => {
  const trace = await controlledTrace(t, "emit('running'); emit('inferior-exited')")
  await assert.rejects(
    trace.run(async () => 'successful command result'),
    /without a clean detach/
  )
  assert.deepEqual(trace.phases(), ['running', 'inferior-exited'])
})
