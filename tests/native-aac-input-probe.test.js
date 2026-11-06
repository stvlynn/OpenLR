import assert from 'node:assert/strict'
import test from 'node:test'
import { chromeAacFixtures, compareAacInput } from '../scripts/native-aac-input-probe.mjs'
import { aacDecoderCookie, aacDescriptionFromCookie } from '../web/audio-config.js'

function referenceReport(fixture, sample = (pcm, i) => pcm[i]) {
  const bytes = Buffer.alloc(fixture.pcm.length * 4)
  fixture.pcm.forEach((_, i) => bytes.writeFloatLE(sample(fixture.pcm, i), i * 4))
  return {
    codedFrames: fixture.packets.length * 1024,
    decodedFrames: fixture.decodedFrames,
    decodeChunks: 3,
    pcm: bytes.toString('base64')
  }
}

test('Chrome generates raw AAC fixtures and the PCM oracle detects sample and channel shifts', async () => {
  const fixtures = await chromeAacFixtures()
  assert.deepEqual(
    fixtures.map(({ sampleRate, channels }) => [sampleRate, channels]),
    [
      [44100, 1],
      [44100, 2],
      [48000, 1],
      [48000, 2]
    ]
  )
  for (const fixture of fixtures) {
    assert.equal(fixture.decodedFrames, fixture.packets.length * 1024)
    const description = Uint8Array.from(fixture.description)
    const cookie = aacDecoderCookie(description, fixture)
    assert.deepEqual(aacDescriptionFromCookie(cookie, fixture), description)
    const result = compareAacInput(fixture, referenceReport(fixture))
    assert.ok(result.every(({ bestLag, relativeRms }) => bestLag === 0 && relativeRms === 0))
  }

  const stereo = fixtures.at(-1)
  const shifted = referenceReport(stereo, (pcm, i) => pcm[i - 2] ?? 0)
  assert.throws(() => compareAacInput(stereo, shifted), /raw waveform differs|same raw PCM origin/)
  const swapped = referenceReport(stereo, (pcm, i) => pcm[i ^ 1])
  assert.throws(() => compareAacInput(stereo, swapped), /preserve distinct channel tones/)
  const truncated = { ...referenceReport(stereo), decodedFrames: stereo.decodedFrames - 1024 }
  assert.throws(() => compareAacInput(stereo, truncated), /full coded PCM/)
})
