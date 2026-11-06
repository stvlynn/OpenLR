import assert from 'node:assert/strict'
import test from 'node:test'
import { compareOpusProbeWindows, parseAudioProbeReport } from '../scripts/native-audio-probe.mjs'

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
      signal: [],
      opusDecoderVariants: []
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
  candidate.opusDecoderVariants = [
    'encoder-cookie-default',
    'no-cookie-default',
    'opushead-zero-default',
    'encoder-cookie-no-prime',
    'opushead-312-default'
  ].map((name) => ({
    name,
    stage: 'decoder-create',
    status: -50,
    decodedFrames: 0,
    firstFrames: 0,
    firstPackets: 0,
    cookieStatus: null,
    setPrimeMethodStatus: null,
    primeMethod: { status: null },
    prime: { status: null },
    signal: [],
    pcmWindowF32le: null
  }))
  const [base] = candidate.opusDecoderVariants
  Object.assign(base, {
    stage: 'complete',
    status: 0,
    decodedFrames: 10560,
    firstFrames: 10560,
    firstPackets: 11,
    prime: candidate.decoderPrime,
    signal: candidate.signal,
    pcmWindowF32le: '00'.repeat(1600 * 4)
  })
  assert.deepEqual(parseAudioProbeReport(JSON.stringify(report)), report)
  const omitted = candidate.opusDecoderVariants.pop()
  assert.throws(() => parseAudioProbeReport(JSON.stringify(report)))
  candidate.opusDecoderVariants.push(omitted)
  candidate.codedFrames++
  assert.throws(() => parseAudioProbeReport(JSON.stringify(report)))
})

test('the Opus PCM oracle aligns the same interleaved signal and quantifies residual error', () => {
  const stereo = Float32Array.of(0.05, -0.25, 0.77, 0.62, -0.42, 0.21, 0.02, -0.02)
  const reference = new Float32Array(stereo.length + 2 * 1024 * 2)
  const start = (1024 + 120) * 2
  reference.set(stereo, start)
  assert.deepEqual(compareOpusProbeWindows(stereo, reference, 2), {
    referenceFrameOffset: 120,
    relativeRmsError: 0
  })
  reference[start] += 0.01
  const changed = compareOpusProbeWindows(stereo, reference, 2)
  assert.equal(changed.referenceFrameOffset, 120)
  assert.ok(changed.relativeRmsError > 0 && changed.relativeRmsError < 0.01)
  assert.equal(compareOpusProbeWindows(new Float32Array(stereo.length), reference, 2), null)
})
