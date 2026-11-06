import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { planAudioExport } from '../web/audio-export.js'
import { encodeNativeAudio } from '../web/native-audio.js'

test('precise audio falls back to AudioToolbox when WebCodecs cannot calibrate its encoder', async (t) => {
  for (const [name, value] of Object.entries({
    mygo: {
      platform: 'darwin',
      call() {
        assert.fail('Codec planning must not open native streams')
      }
    },
    AudioEncoder: class {
      static async isConfigSupported(config) {
        return { config, supported: true }
      }
    },
    AudioDecoder: class {
      static async isConfigSupported(config) {
        return { config, supported: config.codec === 'opus' }
      }
    }
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original)
      else delete globalThis[name]
    })
  }
  const { Mp4OutputFormat, NON_PCM_AUDIO_CODECS, QUALITY_HIGH } =
    await import('../web/vendor/mediabunny/mediabunny.mjs')
  const ordinaryProbes = []
  const media = {
    Mp4OutputFormat,
    NON_PCM_AUDIO_CODECS,
    QUALITY_HIGH,
    async canEncodeAudio(codec, { sampleRate, numberOfChannels }) {
      ordinaryProbes.push([codec, sampleRate, numberOfChannels])
      return codec === 'aac'
    }
  }
  const track = (number, codec) => ({
    number,
    isAudioTrack: () => true,
    getSampleRate: async () => 48_000,
    getNumberOfChannels: async () => 2,
    canDecode: async () => true,
    getCodec: async () => codec
  })
  const opus = track(1, 'opus')
  const flac = track(2, 'flac')
  const format = new Mp4OutputFormat()
  const standalone = await planAudioExport(media, { getTracks: async () => [flac] }, format, true, {})
  assert.equal(standalone, null)
  const precise = await planAudioExport(media, { getTracks: async () => [opus, flac] }, format, true, {})
  assert.ok(precise, 'A supported audio track must retain its precise timeline')
  assert.equal(precise.audio.get(opus).encode, encodeNativeAudio)
  assert.equal(precise.audio.get(opus).codec, 'aac')
  assert.equal(precise.audio.get(flac).codec, 'aac')
  assert.deepEqual(ordinaryProbes, [
    ['aac', 48_000, 2],
    ['aac', 48_000, 2]
  ])
})

test('WebCodecs audio adapter preserves both trim edges and closes a canceled stream', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.route(server.url + '/', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Browser audio adapter</title>' })
  )
  await page.goto(server.url)
  const evidence = await page.evaluate(async () => {
    const { canEncodeBrowserAudio, encodeBrowserAudio, decodeBrowserAac } = await import('/browser-audio.js')
    const { openOpusDecoder } = await import('/opus-decoder.js')
    const configs = [
      ['opus', 48_000, 1],
      ['opus', 48_000, 2],
      ['aac', 48_000, 1],
      ['aac', 48_000, 2],
      ['aac', 44_100, 1],
      ['aac', 44_100, 2]
    ]
    const encoded = []
    const inputFrames = 9_601
    for (const [codec, sampleRate, channels] of configs) {
      const format = { codec, sampleRate, channels }
      if (!(await canEncodeBrowserAudio(format))) continue
      const source = new Float32Array(inputFrames * channels)
      for (let frame = 0; frame < inputFrames; frame++) {
        for (let channel = 0; channel < channels; channel++) {
          const phase = (2 * Math.PI * (421 + channel * 379) * frame) / sampleRate
          source[frame * channels + channel] = 0.25 * Math.sin(phase)
        }
      }
      let info
      const packetStream = encodeBrowserAudio(
        [source.subarray(0, 4037 * channels), source.subarray(4037 * channels)],
        {
          ...format,
          onInfo(value) {
            info = value
          }
        }
      )
      const packets = []
      let result = await packetStream.next()
      while (!result.done) {
        packets.push(result.value)
        result = await packetStream.next()
      }
      const pcm = new Float32Array(result.value.codedFrames * channels)
      let position = 0
      if (codec === 'aac') {
        for await (const block of decodeBrowserAac(packets, { ...format, description: info.description })) {
          pcm.set(block.pcm, position)
          position += block.pcm.length
        }
      } else {
        const decoder = await openOpusDecoder({ numberOfChannels: channels, description: info.description })
        try {
          for (const packet of packets) {
            const block = decoder.decode(packet.data)
            pcm.set(block, position)
            position += block.length
          }
        } finally {
          decoder.close()
        }
      }
      const leading = info.prime.leading
      const edges = []
      for (let channel = 0; channel < channels; channel++) {
        for (const start of [64, inputFrames - 832]) {
          let actual = 0,
            reference = 0,
            correlation = 0
          for (let i = start; i < start + 768; i++) {
            const x = source[i * channels + channel]
            const y = pcm[(leading + i) * channels + channel]
            actual += y * y
            reference += x * x
            correlation += x * y
          }
          edges.push({ rms: Math.sqrt(actual / 768), score: correlation / Math.sqrt(actual * reference) })
        }
      }
      encoded.push({
        ...format,
        leading,
        edges,
        inputFrames: result.value.inputFrames,
        codedFrames: result.value.codedFrames,
        rawDecodedFrames: position / channels
      })
    }

    const controller = new AbortController()
    const reason = Error('canceled audio export')
    const close = AudioEncoder.prototype.close
    let closed = 0,
      returned = false,
      canceled = false
    AudioEncoder.prototype.close = function () {
      closed++
      return close.call(this)
    }
    async function* source() {
      try {
        yield new Float32Array(1024)
        controller.abort(reason)
        yield new Float32Array(1024)
      } finally {
        returned = true
      }
    }
    try {
      const output = encodeBrowserAudio(source(), {
        codec: 'opus',
        sampleRate: 48_000,
        channels: 1,
        signal: controller.signal,
        onInfo() {}
      })
      for await (const _ of output) {
      }
    } catch (error) {
      canceled = error === reason
    } finally {
      AudioEncoder.prototype.close = close
    }
    const { planAudioExport } = await import('/audio-export.js')
    const media = await import('/vendor/mediabunny/mediabunny.mjs')
    const track = (number, codec, channels) => ({
      number,
      isAudioTrack: () => true,
      getCodec: async () => codec,
      getSampleRate: async () => 48_000,
      getNumberOfChannels: async () => channels,
      canDecode: async () => true
    })
    const precise = track(1, 'opus', 2),
      ordinary = track(2, 'flac', 6)
    const format = new media.WebMOutputFormat()
    const probes = []
    const supported = {
      ...media,
      async canEncodeAudio(codec, { numberOfChannels, sampleRate }) {
        probes.push([codec, numberOfChannels, sampleRate])
        return codec === 'vorbis'
      }
    }
    const standalone = await planAudioExport(
      supported,
      { getTracks: async () => [ordinary] },
      format,
      false,
      {}
    )
    const mixed = { getTracks: async () => [precise, ordinary] }
    const retained = await planAudioExport(supported, mixed, format, false, {})
    let incompatible
    try {
      await planAudioExport({ ...media, canEncodeAudio: async () => false }, mixed, format, false, {})
    } catch (error) {
      incompatible = error.message
    }
    return {
      encoded,
      canceled,
      closed,
      returned,
      standalone,
      probes,
      incompatible,
      retained: {
        precise: typeof retained.audio.get(precise).encode === 'function',
        ordinary: retained.audio.get(ordinary).codec
      }
    }
  })
  assert.deepEqual(
    evidence.encoded.filter(({ codec }) => codec === 'opus').map(({ channels }) => channels),
    [1, 2]
  )
  const aac = evidence.encoded.filter(({ codec }) => codec === 'aac')
  if (process.platform === 'win32' && !process.env.CHROME_CHANNEL) assert.equal(aac.length, 4)
  else if (!aac.length) t.diagnostic('This browser has no exact AAC WebCodecs configuration')
  for (const record of evidence.encoded) {
    assert.equal(record.inputFrames, 9601)
    assert.ok(record.leading > 0, JSON.stringify(record))
    assert.equal(record.codedFrames, record.rawDecodedFrames)
    assert.ok(record.codedFrames - record.leading >= record.inputFrames, JSON.stringify(record))
    for (const { rms, score } of record.edges) {
      assert.ok(rms > 0.14 && score > 0.96, JSON.stringify(record))
    }
  }
  assert.equal(evidence.canceled, true)
  assert.equal(evidence.returned, true)
  assert.equal(evidence.closed, 2, 'The Opus timing probe and the canceled source encoder both close')
  assert.equal(evidence.standalone, null)
  assert.deepEqual(evidence.retained, { precise: true, ordinary: 'vorbis' })
  assert.deepEqual(evidence.probes, [
    ['opus', 6, 48_000],
    ['vorbis', 6, 48_000]
  ])
  assert.match(evidence.incompatible, /Audio track 2: .*cannot preserve its sample rate and channel count/)
})
