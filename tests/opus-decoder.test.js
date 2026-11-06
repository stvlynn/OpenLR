import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { openOpusDecoder } from '../web/opus-decoder.js'

const { streams } = JSON.parse(await readFile(new URL('./fixtures/opus/packets.json', import.meta.url)))

function identificationHeader(channels, { preSkip = 312, gain = 0, mapping = 0 } = {}) {
  const bytes = new Uint8Array(25).subarray(3, 22)
  bytes.set(new TextEncoder().encode('OpusHead'))
  bytes.set([1, channels], 8)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint16(10, preSkip, true)
  view.setUint32(12, 44100, true)
  view.setInt16(16, gain, true)
  bytes[18] = mapping
  return bytes
}

function decode(decoder, packets) {
  const frames = packets.reduce((total, packet) => total + packet.frames, 0)
  const pcm = new Float32Array(frames * decoder.channels)
  let offset = 0
  for (const { data, frames } of packets) {
    const samples = decoder.decode(Buffer.from(data, 'hex'))
    assert.ok(samples instanceof Float32Array)
    assert.equal(samples.length, frames * decoder.channels)
    pcm.set(samples, offset)
    offset += samples.length
  }
  return pcm
}

function modeOf(packet) {
  const config = Number.parseInt(packet.data.slice(0, 2), 16) >> 3
  return config < 12 ? 'silk' : config < 16 ? 'hybrid' : 'celt'
}

test('raw Opus keeps the coded sample origin across modes and packet sizes', async () => {
  for (const { name, channels, packets, referenceSamples } of streams) {
    assert.deepEqual(
      packets.map(modeOf),
      packets.map(({ mode }) => mode)
    )
    if (name.endsWith('mixed')) {
      assert.deepEqual([...new Set(packets.map(modeOf))].sort(), ['celt', 'hybrid', 'silk'])
    } else {
      assert.deepEqual(
        [...new Set(packets.map(({ frames }) => frames))],
        [120, 240, 480, 960, 1920, 2880, 5760]
      )
    }
    const decoder = await openOpusDecoder({
      numberOfChannels: channels,
      description: identificationHeader(channels)
    })
    try {
      assert.equal(decoder.sampleRate, 48000)
      assert.equal(decoder.preSkip, 312)
      const pcm = decode(decoder, packets)
      for (const [frame, expected] of referenceSamples)
        for (const [channel, value] of expected.entries()) {
          const actual = pcm[frame * channels + channel]
          assert.ok(
            Math.abs(actual - value) < 2e-6,
            `${name} frame ${frame} channel ${channel}: ${actual} vs ${value}`
          )
        }
    } finally {
      decoder.close()
    }
  }
})

test('fresh Opus decoding with packet preroll agrees with continuous decoding at the same indices', async () => {
  for (const { name, channels, packets } of streams.filter(({ name }) => name.endsWith('mixed'))) {
    const config = { numberOfChannels: channels }
    const continuous = await openOpusDecoder(config)
    let reference
    try {
      reference = decode(continuous, packets)
    } finally {
      continuous.close()
    }
    for (const start of [8, 14]) {
      const fresh = await openOpusDecoder(config)
      try {
        const decoded = decode(fresh, packets.slice(start))
        const origin = packets.slice(0, start).reduce((total, packet) => total + packet.frames, 0) * channels
        let error = 0,
          power = 0
        for (let i = 3840 * channels; i < decoded.length; i++) {
          const expected = reference[origin + i]
          error += (decoded[i] - expected) ** 2
          power += expected ** 2
        }
        assert.ok(power > 0 && Math.sqrt(error / power) < 2e-6, `${name} preroll from packet ${start}`)
      } finally {
        fresh.close()
      }
    }
  }
})

test('Opus output gain is signed, decoded buffers remain owned, and close is idempotent', async () => {
  const { packets } = streams.find(({ name }) => name === 'mono-mixed')
  const raw = await openOpusDecoder({ numberOfChannels: 1 })
  let reference
  try {
    assert.equal(raw.preSkip, 0)
    const first = raw.decode(Buffer.from(packets[0].data, 'hex'))
    const snapshot = first.slice()
    reference = decode(raw, packets.slice(1, 4))
    assert.deepEqual(first, snapshot)
    assert.throws(() => raw.decode(new Uint8Array()), /Expected a raw Opus packet/)
    assert.throws(() => raw.decode(null), /Expected a raw Opus packet/)
  } finally {
    raw.close()
    raw.close()
  }
  assert.throws(() => raw.decode(Buffer.from(packets[0].data, 'hex')), /Opus decoder is closed/)

  for (const db of [-6, 6]) {
    const description = identificationHeader(1, { gain: db * 256 })
    const gained = await openOpusDecoder({ numberOfChannels: 1, description })
    try {
      gained.decode(Buffer.from(packets[0].data, 'hex'))
      const pcm = decode(gained, packets.slice(1, 4))
      const factor = 10 ** (db / 20)
      for (let i = 0; i < pcm.length; i++) assert.ok(Math.abs(pcm[i] - reference[i] * factor) < 2e-4)
    } finally {
      gained.close()
    }
  }
})

test('Opus identification headers reject invalid or unsupported channel mapping', async () => {
  await assert.rejects(openOpusDecoder({ numberOfChannels: 3 }), /requires mono or stereo audio/)
  for (const description of [identificationHeader(1, { mapping: 1 }), identificationHeader(2)]) {
    await assert.rejects(openOpusDecoder({ numberOfChannels: 1, description }), /matching mono or stereo/)
  }
  const truncated = identificationHeader(1).subarray(0, 18)
  const newer = identificationHeader(1)
  newer[8] = 16
  for (const description of [truncated, newer, new Uint8Array(19)]) {
    await assert.rejects(
      openOpusDecoder({ numberOfChannels: 1, description }),
      /Invalid Opus identification header/
    )
  }
})
