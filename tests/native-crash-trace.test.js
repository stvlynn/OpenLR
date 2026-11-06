import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { withHostCrashTrace } from '../scripts/native-crash-trace.mjs'

const pid = 123
const prefix = 'OpenLR host LLDB '

async function controlledTrace(t, body, options = {}) {
  const temporary = await realpath(os.tmpdir())
  const directoryPrefix = 'openlr-host-trace-'
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
  const parsedRecords = () => records.map((line) => JSON.parse(line.slice(prefix.length)))
  return {
    run: async (operation) => {
      try {
        return await withHostCrashTrace({ root, pid }, operation, {
          ...options,
          launch,
          log: (line) => records.push(line)
        })
      } finally {
        assert.equal(launches, 1)
        assert.equal(await readFile(path.join(root, 'host-trace-finished'), 'utf8'), '')
      }
    },
    records: parsedRecords,
    phases: () => parsedRecords().map((record) => record.phase)
  }
}

test('runs once after a delayed resume within the diagnostic budget and waits for detach', async (t) => {
  const trace = await controlledTrace(
    t,
    `console.log('ignore raw debugger output')
    emit('running', 999)
    emit('attach-started')
    setTimeout(() => {
      emit('running')
      const timer = setInterval(() => {
        if (!existsSync(marker)) return
        clearInterval(timer)
        emit('detached')
      }, 5)
    }, 100)`,
    { attachMs: 1000 }
  )
  let calls = 0
  assert.equal(
    await trace.run(async () => {
      calls++
      assert.deepEqual(trace.phases(), ['debugger-launch', 'attach-started', 'running'])
      return 'operation result'
    }),
    'operation result'
  )
  assert.equal(calls, 1)
  assert.deepEqual(trace.phases(), ['debugger-launch', 'attach-started', 'running', 'detached'])
  const [launch, attaching, running] = trace.records()
  assert.equal(launch.attachBudgetMs, 1000)
  assert.ok(running.elapsedMs >= 100 && running.elapsedMs >= attaching.elapsedMs)
})

test('detaches a debugger that resumes after the budget without submitting the operation', async (t) => {
  const trace = await controlledTrace(
    t,
    `const timer = setInterval(() => {
      if (!existsSync(marker)) return
      clearInterval(timer)
      emit('running')
      emit('detached')
    }, 5)`,
    { attachMs: 50 }
  )
  let calls = 0
  await assert.rejects(
    trace.run(async () => calls++),
    /within the diagnostic attach budget/
  )
  assert.equal(calls, 0)
  assert.deepEqual(trace.phases(), ['debugger-launch', 'attach-deadline', 'running', 'detached'])
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
  assert.deepEqual(trace.phases(), ['debugger-launch', 'running', 'fault'])
})

test('reports unavailable attach and does not submit the operation', async (t) => {
  const trace = await controlledTrace(t, "emit('attach-failed')")
  let calls = 0
  await assert.rejects(
    trace.run(async () => calls++),
    /could not attach and resume/
  )
  assert.equal(calls, 0)
  assert.deepEqual(trace.phases(), ['debugger-launch', 'attach-failed'])
})

test('rejects a successful command result when the debugger lost the inferior', async (t) => {
  const trace = await controlledTrace(t, "emit('running'); emit('inferior-exited')")
  await assert.rejects(
    trace.run(async () => 'successful command result'),
    /without a clean detach/
  )
  assert.deepEqual(trace.phases(), ['debugger-launch', 'running', 'inferior-exited'])
})
