import assert from 'node:assert/strict'
import childProcess, { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { promisify } from 'node:util'
import { reportClock, reportReadiness } from '../scripts/native-video-origin-probe.mjs'
import { runProbeHost } from '../scripts/native-probe-host.mjs'
import { makePng } from './fixtures/png.mjs'

test('video readiness retains a metadata-only failure and validates frame and playback evidence', () => {
  const media = { readyState: 1, networkState: 1, width: 96, height: 64, mediaErrorCode: null }
  const observations = ['load-requested', 'loadedmetadata', 'suspend'].map((phase, elapsedMs) => ({
    phase,
    elapsedMs,
    ...media
  }))
  const result = {
    stage: 'media-load',
    errorName: 'Error',
    observations,
    sampleTimes: [],
    nativeRead: [],
    frames: []
  }
  assert.deepEqual(reportReadiness(result).observations, observations)
  assert.equal(reportReadiness(result).verified, false)
  assert.throws(
    () => reportReadiness({ ...result, observations: [...observations, observations[1]] }),
    /repeated readiness phase/
  )

  for (const phase of [
    'loadeddata',
    'frame-decode',
    'first-frame',
    'seek-requested',
    'seek-completed',
    'seek-frame',
    'play-requested',
    'play-started',
    'play-advanced'
  ])
    observations.push({ phase, elapsedMs: observations.length, ...media, readyState: 4 })
  const frame = (time, rgb) => {
    const data = new Uint8Array(96 * 64 * 3)
    for (let i = 0; i < data.length; i += 3) data.set(rgb, i)
    const png = makePng({ width: 96, height: 64, bits: 8, colorType: 2, data })
    return {
      time,
      size: [96, 64],
      read: { value: [...rgb, 255] },
      encode: { value: Buffer.from(png).toString('base64') }
    }
  }
  const red = frame(0, [180, 46, 45])
  const blue = frame(2.35, [44, 61, 198])
  const complete = {
    stage: 'complete',
    observations,
    sampleTimes: [0, 2.35],
    nativeRead: [{ errorName: 'SecurityError' }, { errorName: 'SecurityError' }],
    frames: [red, blue],
    playback: { started: 2.35, advanced: 2.51, playedDuration: 0.16 }
  }
  assert.equal(reportReadiness(complete).verified, true)
  assert.equal(
    reportReadiness({ ...complete, frames: [red, { ...blue, encode: red.encode }] }).verified,
    false
  )
  assert.equal(reportReadiness({ ...complete, sampleTimes: [0, 0] }).verified, false)
  assert.equal(reportReadiness({ ...complete, nativeRead: [red.read, red.read] }).verified, false)
  assert.equal(
    reportReadiness({ ...complete, playback: { started: 0, advanced: 0.2, playedDuration: 0.2 } }).verified,
    false
  )
  assert.throws(() => reportReadiness({ ...complete, playback: undefined }), /Missing playback observation/)
})

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
  result.reads.seekRequested = { ...paused, seeking: true }
  result.reads.seeked = { ...paused, seeking: false }
  result.reads.afterFrame = { ...paused, seeking: false }
  assert.deepEqual(reportClock(result, 'clock-seek').reads, result.reads)
  delete result.reads.seeked
  assert.throws(() => reportClock(result, 'clock-seek'), /Missing playback read seeked/)
  delete result.reads.seekRequested
  delete result.reads.afterFrame
  delete result.reads.afterDelay
  assert.throws(() => reportClock(result, 'clock-delay'), /Missing playback read afterDelay/)
})

test('video probe host distinguishes clean exit and nonzero exit', async () => {
  await runProbeHost(process.execPath, ['-e', 'process.exit(0)'])
  await assert.rejects(
    runProbeHost(process.execPath, ['-e', 'process.exit(7)']),
    /Native probe host failed \(7\)/
  )
})

test('video probe host preserves both output streams and fails at the deadline', async () => {
  const moduleUrl = new URL('../scripts/native-probe-host.mjs', import.meta.url)
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
      /Native probe timed out after 2000ms/
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
    message: 'Native probe host exit was not confirmed',
    cause: denied
  })
  assert.equal(host.unref.mock.callCount(), 1)
})
