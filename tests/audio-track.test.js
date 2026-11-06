import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { planAudioTrack } from '../web/audio-track.js'
import { openOpusDecoder } from '../web/opus-decoder.js'
import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output
} from '../web/vendor/mediabunny/mediabunny.mjs'

const { streams } = JSON.parse(await readFile(new URL('./fixtures/opus/packets.json', import.meta.url)))
const rate = 48000
const opusPackets = streams.find(({ name }) => name === 'celt-durations').packets
const ascii = (value) => Buffer.from(value, 'ascii')
const group = (...values) => Buffer.concat(values)

function number(value, length = 4) {
  const bytes = Buffer.alloc(length)
  if (value < 0) bytes.writeIntBE(value, 0, length)
  else bytes.writeUIntBE(value, 0, length)
  return bytes
}

function element(id, value) {
  let width = 1
  while (value.length >= 2 ** (7 * width) - 1) width++
  return group(Buffer.from(id, 'hex'), number(2 ** (7 * width) + value.length, width), value)
}

function opusHead(preSkip) {
  const bytes = Buffer.alloc(19)
  bytes.set(ascii('OpusHead'))
  bytes.set([1, 1], 8)
  bytes.writeUInt16LE(preSkip, 10)
  bytes.writeUInt32LE(rate, 12)
  return bytes
}

function opusLace(packets, { at = 0, discard = 0, scale = 10000 } = {}) {
  const payloads = packets.map(({ data }) => Buffer.from(data, 'hex'))
  const flags = packets.length === 1 ? 0 : 0x02
  const laceSizes = payloads
    .slice(0, -1)
    .flatMap(({ length }) => [...Array(Math.floor(length / 255)).fill(255), length % 255])
  const lace = flags ? Buffer.from([packets.length - 1, ...laceSizes]) : Buffer.alloc(0)
  const block = group(Buffer.from([0x81]), number(at, 2), Buffer.from([flags]), lace, ...payloads)
  const frames = packets.reduce((total, packet) => total + packet.frames, 0)
  return element(
    'a0',
    group(
      element('a1', block),
      element('9b', number(Math.round((frames * 1e9) / (rate * scale)))),
      ...(discard ? [element('75a2', number(Math.round((discard * 1e9) / rate)))] : [])
    )
  )
}

function opusWebm(blocks, { preSkip = 312, scale = 10000 } = {}) {
  const frequency = Buffer.alloc(8)
  frequency.writeDoubleBE(rate)
  return new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(
      group(
        element('1a45dfa3', element('4282', ascii('webm'))),
        element(
          '18538067',
          group(
            element('1549a966', element('2ad7b1', number(scale))),
            element(
              '1654ae6b',
              element(
                'ae',
                group(
                  element('d7', number(1, 1)),
                  element('73c5', number(1, 1)),
                  element('83', number(2, 1)),
                  element('9c', number(1, 1)),
                  element('86', ascii('A_OPUS')),
                  element('63a2', opusHead(preSkip)),
                  element('56aa', number(Math.round((preSkip * 1e9) / rate))),
                  element('56bb', number(800000000)),
                  element('e1', group(element('b5', frequency), element('9f', number(1, 1))))
                )
              )
            ),
            element('1f43b675', group(element('e7', number(0, 1)), ...blocks))
          )
        )
      )
    )
  })
}

test('real WebM laced BlockGroup exposes its coded origin, signed discard, and declared seek preroll', async (t) => {
  const input = opusWebm([
    opusLace(opusPackets.slice(0, 3), { at: 1000, discard: -200 }),
    opusLace(opusPackets.slice(3, 6), { at: 2750, discard: 3300 })
  ])
  t.after(() => input.dispose())
  const [track] = await input.getAudioTracks()
  assert.equal(await track.getPreRollDuration(), 0.8)
  const sink = new EncodedPacketSink(track)
  const packets = []
  for await (const packet of sink.packets()) packets.push(packet)
  assert.equal(packets.length, 6)
  for (const [index, packet] of packets.entries()) {
    assert.deepEqual(packet.data, new Uint8Array(Buffer.from(opusPackets[index].data, 'hex')))
    assert.deepEqual(packet.sideData.audioLace, {
      index: index % 3,
      count: 3,
      timestamp: (index < 3 ? 0.01 : 0.0275) - 0.0065
    })
  }
  assert.deepEqual(
    packets.map(({ sideData }) => Math.round((sideData.audioDiscardPadding ?? 0) * rate)),
    [-200, 0, 0, 0, 0, 3300]
  )
})

async function allBlocks(input, trim, options) {
  const [track] = await input.getAudioTracks()
  const plan = await planAudioTrack(track, trim, options)
  return Array.fromAsync(plan.blocks())
}

async function rawOpus(packets) {
  const decoder = await openOpusDecoder({ numberOfChannels: 1, description: opusHead(312) })
  try {
    return packets.map(({ data }) => decoder.decode(Buffer.from(data, 'hex')))
  } finally {
    decoder.close()
  }
}

test('actual variable-duration Opus PCM is cropped across laced head and tail discard on a shared clock', async (t) => {
  const input = opusWebm([
    opusLace(opusPackets.slice(0, 3), { at: 1000, discard: -400 }),
    opusLace(opusPackets.slice(3, 6), { at: 2750, discard: 3300 }),
    opusLace(opusPackets.slice(6, 7), { at: 16000 })
  ])
  t.after(() => input.dispose())
  const pcm = await rawOpus(opusPackets.slice(0, 7))
  const blocks = await allBlocks(input, { start: 123 / rate, end: (7368 + 53) / rate })
  assert.deepEqual(blocks, [
    { startFrame: 568 - 123, frames: 440, pcm: pcm[2].subarray(40) },
    { startFrame: 1008 - 123, frames: 960, pcm: pcm[3] },
    { startFrame: 1968 - 123, frames: 1500, pcm: pcm[4].subarray(0, 1500) },
    { startFrame: 7368 - 123, frames: 53, pcm: pcm[6].subarray(0, 53) }
  ])
})

test('Opus pre-skip crosses coded packets once, and releasing the stream closes its decoder', async (t) => {
  const packets = opusPackets.slice(0, 3)
  const input = opusWebm([opusLace(packets)])
  t.after(() => input.dispose())
  const [track] = await input.getAudioTracks()
  const [, reference] = await rawOpus(packets)
  let closed = 0
  const plan = await planAudioTrack(
    track,
    { start: 0, end: 0.02 },
    {
      async openOpus(config) {
        const decoder = await openOpusDecoder(config)
        return {
          ...decoder,
          close() {
            closed++
            decoder.close()
          }
        }
      }
    }
  )
  const iterator = plan.blocks()
  try {
    const first = await iterator.next()
    assert.deepEqual(first, {
      done: false,
      value: { startFrame: 0, frames: 48, pcm: reference.subarray(192) }
    })
  } finally {
    await iterator.return()
  }
  assert.equal(closed, 1)
})

test('an interior 1 ms WebM seek retains the original Opus sample phase and only decodes preroll', async (t) => {
  const sequence = streams.find(({ name }) => name === 'mono-mixed').packets
  const packets = Array.from({ length: 84 }, (_, i) => sequence[i % sequence.length])
  const scale = 1_000_000
  const input = opusWebm(
    packets.map((packet, i) => opusLace([packet], { at: i ? i * 20 + 1 : 0, scale })),
    { scale }
  )
  t.after(() => input.dispose())
  const start = 52803
  const frames = 9601
  const reference = (await rawOpus(packets))
    .flatMap((pcm) => Array.from(pcm))
    .slice(start + 312, start + 312 + frames)
  let calls = 0
  const blocks = await allBlocks(
    input,
    { start: start / rate, end: (start + frames) / rate },
    {
      async openOpus(config) {
        const decoder = await openOpusDecoder(config)
        return {
          ...decoder,
          decode(data) {
            calls++
            return decoder.decode(data)
          }
        }
      }
    }
  )
  let offset = 0,
    squareError = 0,
    power = 0
  for (const block of blocks) {
    assert.equal(block.startFrame, offset)
    for (const value of block.pcm) {
      squareError += (value - reference[offset]) ** 2
      power += reference[offset] ** 2
      offset++
    }
  }
  assert.equal(offset, frames)
  assert.ok(
    calls < Math.ceil((start + frames + 312) / 960),
    'PCM decode should begin at the preroll key packet'
  )
  assert.ok(power > 0 && Math.sqrt(squareError / power) < 2e-6)
})

async function aacMp4() {
  const sampleRate = 44100
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat({ movieTimescale: 14_112_000 }), target })
  const audio = new EncodedAudioPacketSource('aac')
  output.addAudioTrack(audio)
  await output.start()
  for (let i = 0; i < 4; i++) {
    await audio.add(
      new EncodedPacket(
        Uint8Array.of(i, 0x44),
        'key',
        (5000 - 2112 + i * 1024) / sampleRate,
        1024 / sampleRate,
        i,
        undefined,
        i === 0
          ? { audioPriming: 2112 / sampleRate }
          : i === 3
            ? { audioDiscardPadding: 575 / sampleRate }
            : {}
      ),
      i === 0
        ? {
            decoderConfig: {
              codec: 'mp4a.40.2',
              sampleRate,
              numberOfChannels: 2,
              description: Uint8Array.of(0x12, 0x10)
            }
          }
        : undefined
    )
  }
  audio.close()
  await output.finalize()
  return new Input({ formats: ALL_FORMATS, source: new BufferSource(target.buffer) })
}

test('actual MP4 edit bounds clip injected AAC PCM across mismatched decoder block sizes', async (t) => {
  const input = await aacMp4()
  t.after(() => input.dispose())
  const sampleRate = 44100
  const blocks = await allBlocks(
    input,
    { start: 4800 / sampleRate, end: 7000 / sampleRate },
    {
      async *decodeAac(source, config) {
        assert.deepEqual(config.description, Uint8Array.of(0x12, 0x10))
        const packets = await Array.fromAsync(source)
        assert.deepEqual(
          packets.map(({ data, frames }) => [data[0], frames]),
          [
            [1, 1024],
            [2, 1024],
            [3, 1024]
          ]
        )
        for (let start = 1024; start < 4096; start += 700) {
          const frames = Math.min(700, 4096 - start)
          const pcm = new Float32Array(frames * 2)
          for (let i = 0; i < frames; i++) pcm.set([start + i, -(start + i)], i * 2)
          yield { pcm, frames }
        }
      }
    }
  )
  let outputFrame = 200
  let coded = 2112
  for (const block of blocks) {
    assert.equal(block.startFrame, outputFrame)
    for (let i = 0; i < block.frames; i++, coded++) {
      assert.equal(block.pcm[i * 2], coded)
      assert.equal(block.pcm[i * 2 + 1], -coded)
    }
    outputFrame += block.frames
  }
  assert.equal(outputFrame, 200 + 1409)
  assert.equal(coded, 3521)
})
