// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { encoderConfig, probeColors, runEncoderCase } from '../scripts/fixtures/encoder-probe/probe.js'
import { encoderOrder, verifyEncoderPackets } from '../scripts/native-encoder-probe.mjs'
import { runProbeHost } from '../scripts/native-probe-host.mjs'
import { Input, BufferSource, ALL_FORMATS, EncodedPacketSink } from '../web/vendor/mediabunny/mediabunny.mjs'

async function temporary(t) {
  const parent = await realpath(tmpdir())
  const directory = await mkdtemp(path.join(parent, 'olr-et-'))
  t.after(async () => {
    const cleanup = await realpath(directory)
    assert.equal(path.dirname(cleanup), parent)
    assert.ok(path.basename(cleanup).startsWith('olr-et-'))
    await rm(cleanup, { recursive: true, force: true })
  })
  return directory
}

class Frame {
  constructor(canvas, options) {
    this.timestamp = options.timestamp
    this.duration = options.duration
  }
  close() {
    this.closed = true
  }
}
class BufferedEncoder extends EventTarget {
  static async isConfigSupported(config) {
    return { supported: true, config }
  }
  constructor(callbacks) {
    super()
    this.callbacks = callbacks
    this.state = 'unconfigured'
    this.encodeQueueSize = 0
    this.pending = []
    this.outputs = 0
  }
  configure(config) {
    this.config = config
    this.state = 'configured'
  }
  encode(frame, options) {
    this.encodeQueueSize++
    this.pending.push({ timestamp: frame.timestamp, duration: frame.duration, key: options.keyFrame })
    queueMicrotask(() => {
      this.encodeQueueSize--
      this.dispatchEvent(new Event('dequeue'))
    })
  }
  async flush() {
    for (const packet of this.pending.splice(0)) {
      this.callbacks.output(
        { ...packet, type: packet.key ? 'key' : 'delta', byteLength: 1, copyTo: (bytes) => bytes.set([1]) },
        this.outputs++ === 0
          ? { decoderConfig: { codec: encoderConfig.codec, description: new Uint8Array([1, 66]) } }
          : {}
      )
    }
  }
  close() {
    this.state = 'closed'
  }
}
const dependencies = {
  Encoder: BufferedEncoder,
  Frame,
  makeCanvas: () => ({ getContext: () => ({ fillRect() {} }) }),
  feedMs: 200,
  flushMs: 100
}

test('five controls use exact absent-framerate configs in mirrored fresh-host order', () => {
  assert.equal(encoderOrder.length, 10)
  assert.deepEqual(encoderOrder.slice(0, 5), encoderOrder.slice(5).toReversed())
  assert.equal('framerate' in encoderConfig, false)
})

test('quality periodic flush preserves one configured encoder and all fifteen input/output positions', async () => {
  const report = await runEncoderCase('quality-software-flush3', dependencies)
  assert.equal(report.outcome, 'complete')
  assert.deepEqual(
    report.flushes.map(({ submitted, output, outcome }) => [submitted, output, outcome]),
    [3, 6, 9, 12, 15].map((count) => [count, count, 'resolved'])
  )
  assert.deepEqual(
    report.chunks.map(({ timestamp }) => timestamp),
    Array.from({ length: 15 }, (_, index) => index * 100000)
  )
  assert.equal(report.observations.filter(({ event }) => event === 'configured').length, 1)
  assert.equal(report.terminalBeforeClose.state, 'configured')
  assert.equal(report.observations.at(-1).state, 'closed')
})

test('a stalled dequeue becomes a retained feed timeout rather than a passing or flushed result', async () => {
  class Blocked extends BufferedEncoder {
    encode() {
      this.encodeQueueSize++
    }
  }
  const report = await runEncoderCase('quality-software', { ...dependencies, Encoder: Blocked, feedMs: 40 })
  assert.equal(report.outcome, 'feed-timeout')
  assert.equal(report.submitted, 4)
  assert.equal(report.output, 0)
  assert.equal(report.terminalBeforeClose.queueSize, 4)
  assert.deepEqual(report.flushes, [])
  assert.equal(report.observations.at(-1).state, 'closed')
})

test('a never-resolving encoder flush retains its failed phase and actual submitted count', async () => {
  class BlockedFlush extends BufferedEncoder {
    flush() {
      return new Promise(() => {})
    }
  }
  const report = await runEncoderCase('quality-default', {
    ...dependencies,
    Encoder: BlockedFlush,
    flushMs: 40
  })
  assert.equal(report.outcome, 'final-flush-timeout')
  assert.equal(report.submitted, 15)
  assert.equal(report.flushes[0].outcome, 'timeout')
  assert.equal(report.failure.phase, 'final-flush')
})

test('recorded actual child exit retains both streams and its real ownership receipt', async (t) => {
  const directory = await temporary(t)
  const receipt = await runProbeHost(
    process.execPath,
    ['-e', "console.log('actual stdout');console.error('actual stderr')"],
    { recordDirectory: directory, ownGroup: true }
  )
  assert.equal(receipt.exitConfirmed, true)
  assert.equal(receipt.forced, false)
  assert.equal(receipt.code, 0)
  assert.equal(receipt.signal, null)
  assert.match(await readFile(path.join(directory, 'stdout.log'), 'utf8'), /actual stdout/)
  assert.match(await readFile(path.join(directory, 'stderr.log'), 'utf8'), /actual stderr/)
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'process.json'), 'utf8')), receipt)
})

test('recorded actual child timeout confirms termination and never returns success', async (t) => {
  const directory = await temporary(t)
  await assert.rejects(
    runProbeHost(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      recordDirectory: directory,
      ownGroup: true,
      timeout: 200
    }),
    /Native probe timed out/
  )
  const receipt = JSON.parse(await readFile(path.join(directory, 'process.json'), 'utf8'))
  assert.equal(receipt.exitConfirmed, true)
  assert.equal(receipt.forced, true)
  assert.ok(receipt.signal !== null || receipt.code !== 0)
})

test('real FFmpeg AVC packets survive the retained-packet remux and strict fifteen-frame color verifier', async (t) => {
  const tools = process.env.OPENLR_FFMPEG_DIR
  if (!tools) return t.skip('Set OPENLR_FFMPEG_DIR to execute the actual codec-path test')
  const directory = await temporary(t)
  const rgba = Buffer.alloc(15 * 64 * 96 * 4)
  for (let index = 0; index < 15; index++) {
    const color = probeColors[Math.floor(index / 5)]
    for (let pixel = 0; pixel < 64 * 96; pixel++) rgba.set([...color, 255], (index * 64 * 96 + pixel) * 4)
  }
  const file = path.join(directory, 'independent.mp4')
  execFileSync(
    path.join(tools, 'ffmpeg' + (process.platform === 'win32' ? '.exe' : '')),
    [
      '-v',
      'error',
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgba',
      '-video_size',
      '64x96',
      '-framerate',
      '10',
      '-i',
      'pipe:0',
      '-frames:v',
      '15',
      '-c:v',
      'libx264',
      '-profile:v',
      'baseline',
      '-level:v',
      '1',
      '-b:v',
      '25000',
      '-pix_fmt',
      'yuv420p',
      file
    ],
    { input: rgba, timeout: 15000, windowsHide: true }
  )
  const input = new Input({ source: new BufferSource(await readFile(file)), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    const config = await track.getDecoderConfig()
    const packets = await Array.fromAsync(new EncodedPacketSink(track).packets())
    const report = {
      candidate: 'quality-default',
      requestedConfig: { ...encoderConfig },
      outcome: 'complete',
      submitted: 15,
      output: packets.length,
      chunks: packets.map((packet, index) => ({
        timestamp: Math.round(packet.timestamp * 1e6),
        duration: Math.round(packet.duration * 1e6),
        type: packet.type,
        dataBase64: Buffer.from(packet.data).toString('base64'),
        byteLength: packet.data.length,
        ...(index === 0
          ? {
              decoderConfig: {
                ...config,
                description: undefined,
                descriptionBase64: Buffer.from(config.description).toString('base64')
              }
            }
          : {})
      }))
    }
    await writeFile(path.join(directory, 'input-report.json'), JSON.stringify(report))
    const result = await verifyEncoderPackets(report, directory, tools)
    assert.equal(result.verified, true)
    assert.equal(result.decodedFrames, 15)
    report.outcome = 'final-flush-timeout'
    assert.equal((await verifyEncoderPackets(report, directory, tools)).verified, false)
  } finally {
    input.dispose()
  }
})
