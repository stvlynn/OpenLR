import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAudioProbeReport } from '../scripts/native-audio-probe.mjs'

function reportFixture() {
  const configurations = [
    ['opus-48000-mono', 'opus', 48000, 1],
    ['opus-48000-stereo', 'opus', 48000, 2],
    ['aac-48000-mono', 'aac', 48000, 1],
    ['aac-48000-stereo', 'aac', 48000, 2],
    ['aac-44100-stereo', 'aac', 44100, 2]
  ]
  return {
    encodeFormats: { status: 0, aac: true, opus: false },
    decodeFormats: { status: 0, aac: true, opus: true },
    candidates: configurations.map(([name, codec, sampleRate, channels]) => ({
      name,
      codec,
      sampleRate,
      channels,
      stage: 'encoder-create',
      status: -50,
      inputFrames: 9601,
      codedFrames: 0,
      decodedFrames: 0,
      framesPerPacket: 0,
      encoderPrime: { status: null },
      decoderPrime: { status: null },
      cookieStatus: null,
      cookie: '',
      packets: [],
      signal: []
    }))
  }
}

test('AudioToolbox probe accepts a complete matrix containing candidate failures', () => {
  const report = reportFixture()
  assert.deepEqual(parseAudioProbeReport(JSON.stringify(report)), report)
  report.candidates.pop()
  assert.throws(() => parseAudioProbeReport(JSON.stringify(report)), /Incomplete AudioToolbox probe/)
})

test('AudioToolbox probe requires PCM evidence and matching packet counts for a successful candidate', () => {
  const report = reportFixture()
  const candidate = report.candidates[0]
  Object.assign(candidate, { stage: 'complete', status: 0 })
  assert.throws(() => parseAudioProbeReport(JSON.stringify(report)))
  Object.assign(candidate, {
    codedFrames: 10560,
    decodedFrames: 10560,
    encoderPrime: { status: 0, leading: 312, trailing: 0 },
    decoderPrime: { status: -50 },
    cookieStatus: -50,
    packets: Array.from({ length: 11 }, () => ({ frames: 960, data: '78' })),
    signal: [{ peak: 0.75, pulseOffset: 312, toneAmplitude: 0.22 }]
  })
  assert.deepEqual(parseAudioProbeReport(JSON.stringify(report)), report)
  candidate.codedFrames++
  assert.throws(() => parseAudioProbeReport(JSON.stringify(report)))
})
