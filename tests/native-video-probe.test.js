import assert from 'node:assert/strict'
import childProcess, { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { promisify } from 'node:util'
import { reportClock, runProbeHost } from '../scripts/native-video-origin-probe.mjs'

test('video pause probe requires post-seek and post-frame observations when a rewind is repaired', () => {
  const playing = { time: 0.54, paused: false },
    rewound = { time: 0.35, paused: true },
    restored = { time: 0.54, paused: true }
  const result = {
    stage: 'complete',
    frameSource: 'decoded',
    playedDuration: 0,
    observationMs: 14,
    reads: {
      started: { time: 0.35, paused: false },
      advanced: playing,
      beforePause: playing,
      immediate: rewound,
      pauseEvent: rewound,
      animationFrame: rewound,
      afterFrame: rewound,
      restored,
      restoredAfterFrame: restored
    }
  }
  assert.deepEqual(reportClock(result, 'clock-restore').reads, result.reads)
  delete result.reads.restoredAfterFrame
  assert.throws(() => reportClock(result, 'clock-restore'), /Missing playback read restoredAfterFrame/)
  delete result.reads.pauseEvent
  assert.throws(() => reportClock(result, 'clock-restore'), /Missing playback read pauseEvent/)
})

test('the elapsed playback control requires a clock read after the paired delay', () => {
  const playing = { time: 0.54, paused: false },
    paused = { time: 0.54, paused: true }
  const result = {
    stage: 'complete',
    frameSource: 'decoded',
    playedDuration: 0.19,
    observationMs: 15,
    requestedDelayMs: 14,
    reads: {
      started: { time: 0.35, paused: false },
      advanced: playing,
      beforePause: playing,
      immediate: paused,
      pauseEvent: paused,
      animationFrame: paused,
      afterDelay: paused
    }
  }
  assert.equal(reportClock(result, 'clock-delay').requestedDelayMs, 14)
  delete result.reads.afterDelay
  assert.throws(() => reportClock(result, 'clock-delay'), /Missing playback read afterDelay/)
})

test('video probe host distinguishes clean exit and nonzero exit', async () => {
  await runProbeHost(process.execPath, ['-e', 'process.exit(0)'])
  await assert.rejects(
    runProbeHost(process.execPath, ['-e', 'process.exit(7)']),
    /Video origin probe host failed \(7\)/
  )
})

test('video probe host preserves both output streams and fails at the deadline', async () => {
  const moduleUrl = new URL('../scripts/native-video-origin-probe.mjs', import.meta.url)
  const gracefulHost = `
    process.on('SIGTERM', () => process.exit(0))
    console.log('probe stdout: host started')
    console.error('probe stderr: candidate started')
    setTimeout(() => process.exit(0), 5000)
  `
  // Capture the streams inherited by the host from its immediate Node parent.
  const runner = `
    import assert from 'node:assert/strict'
    import { runProbeHost } from ${JSON.stringify(moduleUrl.href)}
    await assert.rejects(
      runProbeHost(process.execPath, ['-e', ${JSON.stringify(gracefulHost)}], { timeout: 2000 }),
      /Video origin probe timed out after 2000ms/
    )
  `
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '--eval', runner],
    { timeout: 10000 }
  )
  assert.match(stdout, /probe stdout: host started/)
  assert.match(stderr, /probe stderr: candidate started/)
})

test('video probe distinguishes unconfirmed child exit from a closed host', async (t) => {
  const denied = Object.assign(new Error('Signal rejected'), { code: 'EPERM' })
  const host = Object.assign(new EventEmitter(), { pid: 1234, exitCode: null, signalCode: null })
  host.kill = (signal) => {
    assert.equal(signal, 'SIGKILL')
    host.emit('error', denied)
    return false
  }
  host.unref = t.mock.fn()
  t.mock.method(childProcess, 'spawn', () => host)
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })

  await assert.rejects(runProbeHost(process.execPath, [], { timeout: 1 }), {
    message: 'Video origin probe host exit was not confirmed',
    cause: denied
  })
  assert.equal(host.unref.mock.callCount(), 1)
})
