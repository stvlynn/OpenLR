import test from 'node:test'
import assert from 'node:assert/strict'
import {
  audioMovieTimescale,
  audioPacketTiming,
  audioTailFrames,
  audioTrimFrames
} from '../web/audio-timing.js'

test('audio trim intersects the intrinsic edit and retains a delayed start on the shared timeline', () => {
  const rate = 48_000,
    trim = { start: 1.200001, end: 2.700002 },
    presentation = { start: 1.5615208333333334, end: 1.7615416666666666 }
  assert.deepEqual(audioTrimFrames(trim, rate, presentation), {
    start: 74_953,
    end: 84_554,
    outputStart: 17_353
  })
  assert.deepEqual(audioTrimFrames(trim, rate, { start: -0.0065, end: 4 }), {
    start: 57_600,
    end: 129_600,
    outputStart: 0
  })
  assert.equal(audioTrimFrames(trim, rate, { start: trim.end, end: 4 }), null)
  assert.equal(audioTrimFrames({ start: 0, end: 0.000001 }, rate), null)
  assert.throws(() => audioTrimFrames({ start: 0, end: Infinity }, rate), /cannot be represented/)
})

test('adjacent nonaligned trims share one sample boundary at both native sample rates', () => {
  for (const rate of [44_100, 48_000]) {
    const left = audioTrimFrames({ start: 0.2, end: 0.401234 }, rate),
      right = audioTrimFrames({ start: 0.401234, end: 0.63 }, rate),
      whole = audioTrimFrames({ start: 0.2, end: 0.63 }, rate)
    assert.equal(left.end, right.start)
    assert.equal(left.end - left.start + right.end - right.start, whole.end - whole.start)
  }
})

test('encoded packet timing retains full coded AAC durations with multi-packet priming and exact final discard', () => {
  const sampleRate = 44_100,
    outputStart = 0,
    leadingFrames = 2112,
    codedFrames = 12_288,
    packetFrames = 1024,
    audibleFrames = 9601,
    common = { sampleRate, outputStart, leadingFrames, packetFrames }
  const first = audioPacketTiming({ ...common, codedBefore: 0 }),
    second = audioPacketTiming({ ...common, codedBefore: packetFrames }),
    tailFrames = audioTailFrames(codedFrames, leadingFrames, audibleFrames),
    last = audioPacketTiming({ ...common, codedBefore: codedFrames - packetFrames, tailFrames })
  assert.equal(first.timestamp * sampleRate, -2112)
  assert.deepEqual(first.sideData, { audioPriming: 2112 / sampleRate })
  assert.equal(second.timestamp * sampleRate, -1088)
  assert.deepEqual(second.sideData, {})
  assert.equal(last.duration * sampleRate, packetFrames)
  assert.equal(tailFrames, 575)
  assert.deepEqual(last.sideData, { audioDiscardPadding: 575 / sampleRate })
  assert.equal(
    Math.round((last.timestamp + last.duration - last.sideData.audioDiscardPadding) * sampleRate),
    9601
  )
  assert.throws(() => audioTailFrames(codedFrames, leadingFrames, 11_000), /does not cover/)
})

test('delayed Opus keeps the same codec priming while changing the first presentation position', () => {
  const first = audioPacketTiming({
    sampleRate: 48_000,
    outputStart: 17_353,
    leadingFrames: 312,
    codedBefore: 0,
    packetFrames: 960
  })
  assert.equal(Math.round((first.timestamp + first.sideData.audioPriming) * 48_000), 17_353)
  assert.equal(first.duration, 0.02)
  assert.equal(audioTailFrames(10_560, 312, 9601), 647)
})

test('MP4 movie ticks represent every configured rate exactly until the format integer limit', () => {
  assert.equal(audioMovieTimescale([]), 57_600)
  assert.equal(audioMovieTimescale([48_000]), 288_000)
  assert.equal(audioMovieTimescale([44_100, 48_000, 48_000]), 14_112_000)
  assert.throws(() => audioMovieTimescale([1_000_003, 48_000]), /cannot represent/)
  assert.throws(() => audioMovieTimescale([0]), /sample rate/)
})
