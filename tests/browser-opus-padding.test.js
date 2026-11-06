import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makeVideoFixture } from './fixtures/video.mjs'

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.route(server.url + '/', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html>' })
  )
  await page.goto(server.url)
  return page
}

test('browser Opus preflight preserves the exact sample count and final PCM across packet phases', async (t) => {
  const page = await workspace(t)
  const rows = await page.evaluate(async () => {
    const { encodeBrowserAudio } = await import('/browser-audio.js')
    const { openOpusDecoder } = await import('/opus-decoder.js')
    const configure = AudioEncoder.prototype.configure
    const encode = AudioEncoder.prototype.encode
    const traces = new WeakMap()
    let calls
    AudioEncoder.prototype.configure = function (config) {
      const trace = { config, frames: 0 }
      traces.set(this, trace)
      calls.push(trace)
      return configure.call(this, config)
    }
    AudioEncoder.prototype.encode = function (pcm) {
      traces.get(this).frames += pcm.numberOfFrames
      return encode.call(this, pcm)
    }

    const results = []
    for (const [frames, channels] of [
      [240, 1],
      [648, 1],
      [649, 1],
      [959, 2],
      [9601, 2],
      [72000, 1]
    ]) {
      calls = []
      const pcm = new Float32Array(frames * channels)
      const pulses = Array.from({ length: channels }, (_, channel) => frames - 37 - 80 * channel)
      for (const [channel, pulse] of pulses.entries()) {
        for (let i = -30; i <= 30; i++) {
          pcm[(pulse + i) * channels + channel] = 0.85 * Math.exp(-0.5 * (i / 8) ** 2) * Math.cos(i * 0.41)
        }
      }
      const source = []
      for (let offset = 0; offset < pcm.length; offset += 613 * channels) {
        source.push(pcm.subarray(offset, offset + 613 * channels))
      }
      const iterator = encodeBrowserAudio(source, { codec: 'opus', sampleRate: 48000, channels })
      const decoder = await openOpusDecoder({ numberOfChannels: channels })
      const decoded = []
      const packetFrames = []
      let result
      try {
        while (!(result = await iterator.next()).done) {
          packetFrames.push(result.value.frames)
          decoded.push(...decoder.decode(result.value.data))
        }
      } finally {
        await iterator.return()
        decoder.close()
      }
      const {
        inputFrames,
        codedFrames,
        prime: { leading }
      } = result.value
      const peaks = pulses.map((pulse, channel) => {
        let peak = 0,
          at = -1
        for (let i = pulse + leading - 8; i <= pulse + leading + 8; i++) {
          const value = decoded[i * channels + channel]
          if (value > peak) [at, peak] = [i, value]
        }
        return { at, peak, expected: pulse + leading }
      })
      results.push({
        frames,
        channels,
        calls,
        inputFrames,
        codedFrames,
        leading,
        peaks,
        decodedFrames: decoded.length / channels,
        packetFrames: [...new Set(packetFrames)]
      })
    }
    return results
  })

  for (const row of rows) {
    const { frames, channels, calls, inputFrames, leading, codedFrames, decodedFrames, peaks, packetFrames } =
      row
    const required = Math.ceil((frames + leading) / 960) * 960
    assert.deepEqual(
      calls.map((call) => call.frames),
      [960, required]
    )
    assert.ok(
      calls.every(({ config }) => config.opus.frameDuration === 20000 && config.numberOfChannels === channels)
    )
    assert.equal(inputFrames, frames)
    assert.deepEqual(packetFrames, [960])
    assert.equal(decodedFrames, codedFrames)
    assert.ok(codedFrames >= required)
    assert.ok(
      peaks.every(({ at, expected, peak }) => at === expected && peak > 0.75),
      JSON.stringify(row)
    )
  }
})

test('short WebM export discards Chrome Opus packets that only contain padding', async (t) => {
  const page = await workspace(t)
  const source = await makeVideoFixture(page)
  const frames = 4801
  const evidence = await page.evaluate(
    async ({ source, frames }) => {
      const media = await import('/vendor/mediabunny/mediabunny.mjs')
      const { exportVideo } = await import('/video.js')
      const sampleRate = 48_000
      const observed = []
      const NativeAudioEncoder = AudioEncoder
      function ObservedAudioEncoder(init) {
        const packets = []
        observed.push(packets)
        return new NativeAudioEncoder({
          ...init,
          output(chunk, metadata) {
            const bytes = new Uint8Array(chunk.byteLength)
            chunk.copyTo(bytes)
            packets.push(media.parseOpusTocByte(bytes).durationInSamples)
            init.output(chunk, metadata)
          }
        })
      }
      ObservedAudioEncoder.isConfigSupported = NativeAudioEncoder.isConfigSupported.bind(NativeAudioEncoder)
      globalThis.AudioEncoder = ObservedAudioEncoder
      let blob
      try {
        const file = new File([Uint8Array.from(source)], 'short-source.webm', { type: 'video/webm' })
        ;({ blob } = await exportVideo(
          file,
          {
            name: file.name,
            width: 96,
            height: 64,
            edit: { trim: { start: 1.2, end: 1.2 + frames / sampleRate } }
          },
          { format: 'video/webm' }
        ))
      } finally {
        globalThis.AudioEncoder = NativeAudioEncoder
      }

      const input = new media.Input({ formats: media.ALL_FORMATS, source: new media.BlobSource(blob) })
      try {
        const tracks = await input.getAudioTracks()
        const [track] = tracks
        const config = await track.getDecoderConfig()
        const leading = new DataView(new Uint8Array(config.description).buffer).getUint16(10, true)
        const sink = new media.EncodedPacketSink(track)
        let muxed = 0,
          last
        for await (const packet of sink.packets()) {
          muxed += media.parseOpusTocByte(packet.data).durationInSamples
          last = packet
        }
        const context = new OfflineAudioContext(1, 1, sampleRate)
        const audio = await context.decodeAudioData(await blob.arrayBuffer())
        const samples = audio.getChannelData(0)
        const tail = samples.subarray(samples.length - 128)
        return {
          trackCount: tracks.length,
          backendCoded: observed.map((packets) => packets.reduce((sum, count) => sum + count, 0)),
          leading,
          muxed,
          discard: Math.round(last.sideData.audioDiscardPadding * sampleRate),
          audibleFrames: audio.length,
          tailRms: Math.sqrt(tail.reduce((sum, x) => sum + x * x, 0) / tail.length)
        }
      } finally {
        input.dispose()
      }
    },
    { source: Array.from(source), frames }
  )
  const { backendCoded, leading, muxed, discard, audibleFrames, tailRms } = evidence
  t.diagnostic(JSON.stringify(evidence))
  assert.equal(evidence.trackCount, 1)
  assert.equal(backendCoded.length, 2)
  assert.equal(backendCoded[1], muxed + 960, 'Chrome flush produced one extra whole coded packet')
  assert.equal(muxed, Math.ceil((frames + leading) / 960) * 960)
  assert.equal(discard, muxed - leading - frames)
  assert.equal(audibleFrames, frames)
  assert.ok(tailRms > 0.08)
})
