import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test(
  'video audio fallback preserves a delayed stereo track and trimmed mono samples with an injected encoder',
  { timeout: 90_000 },
  async (t) => {
    const server = await serveWorkspace()
    t.after(server.close)
    const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
    t.after(() => browser.close())
    const page = await browser.newPage()
    await page.goto(server.url)
    const evidence = await page.evaluate(async () => {
      const media = await import('/vendor/mediabunny/mediabunny.mjs')
      const { exportVideo } = await import('/video.js')
      const sampleRate = 48_000
      const start = 0.18723
      const end = 2.31102
      const width = 96
      const height = 64
      const delays = [0, 27_000]
      const counts = [130_560, 94_720]
      const names = ['Primary mono', 'Delayed stereo']
      const languages = ['eng', 'fra']
      const frame = (seconds) => Math.round(seconds * sampleRate)
      const inputBytes = (blob) => blob.arrayBuffer().then((buffer) => Array.from(new Uint8Array(buffer)))
      const makeInput = (blob) =>
        new media.Input({ formats: media.ALL_FORMATS, source: new media.BlobSource(blob) })

      async function browserEncode(blocks, channels, signal) {
        const packets = []
        let description,
          failure,
          submitted = 0
        const encoder = new AudioEncoder({
          output(chunk, metadata) {
            if (metadata.decoderConfig?.description)
              description = new Uint8Array(metadata.decoderConfig.description)
            const data = new Uint8Array(chunk.byteLength)
            chunk.copyTo(data)
            packets.push({ data, frames: frame(chunk.duration / 1e6) })
          },
          error(error) {
            failure = error
          }
        })
        try {
          encoder.configure({ codec: 'opus', numberOfChannels: channels, sampleRate, bitrate: 96_000 })
          for await (const pcm of blocks) {
            signal?.throwIfAborted()
            const frames = pcm.length / channels
            const data = new AudioData({
              format: 'f32',
              data: pcm,
              numberOfFrames: frames,
              numberOfChannels: channels,
              sampleRate,
              timestamp: Math.round((submitted / sampleRate) * 1e6)
            })
            try {
              encoder.encode(data)
            } finally {
              data.close()
            }
            submitted += frames
          }
          await encoder.flush()
          if (failure) throw failure
        } finally {
          if (encoder.state !== 'closed') encoder.close()
        }
        const leading = new DataView(description.buffer).getUint16(10, true)
        const coded = packets.reduce((total, packet) => total + packet.frames, 0)
        return { packets, leading, coded, description, submitted }
      }

      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      const target = new media.BufferTarget()
      const fixture = new media.Output({
        target,
        format: new media.WebMOutputFormat({ timestampScale: 10_000 })
      })
      fixture.setMetadataTags({ title: 'Generated multitrack fixture' })
      const video = new media.CanvasSource(canvas, { codec: 'vp9', bitrate: 300_000 })
      fixture.addVideoTrack(video)
      const audio = names.map((name, index) => {
        const source = new media.EncodedAudioPacketSource('opus')
        fixture.addAudioTrack(source, {
          name,
          languageCode: languages[index],
          disposition: { default: index === 0 }
        })
        return source
      })
      await fixture.start()
      const audioDone = Promise.all(
        audio.map(async (source, index) => {
          const channels = index + 1
          const pcm = new Float32Array(counts[index] * channels)
          for (let i = 0; i < counts[index]; i++) {
            const time = (i + delays[index]) / sampleRate
            if (index === 0) {
              const frequency = time < 0.75 ? 330 : time < 1.6 ? 660 : 990
              pcm[i] = 0.3 * Math.sin(2 * Math.PI * frequency * time)
            } else {
              pcm[i * 2] = 0.3 * Math.sin(2 * Math.PI * 440 * time)
              pcm[i * 2 + 1] = 0.3 * Math.sin(2 * Math.PI * 880 * time)
            }
          }
          const { packets, leading, coded, description } = await browserEncode([pcm], channels)
          let position = delays[index] - leading
          for (const [packetIndex, { data, frames }] of packets.entries()) {
            if (index === 1 && packetIndex >= 40 && packetIndex < 50) {
              position += frames
              continue // An actual 200 ms hole in the encoded stereo timeline.
            }
            const sideData = packetIndex === 0 ? { audioPriming: leading / sampleRate } : {}
            if (packetIndex === packets.length - 1)
              sideData.audioDiscardPadding = (coded - leading - counts[index]) / sampleRate
            const packet = new media.EncodedPacket(
              data,
              'key',
              position / sampleRate,
              frames / sampleRate,
              -1,
              undefined,
              sideData
            )
            await source.add(
              packet,
              packetIndex === 0
                ? { decoderConfig: { codec: 'opus', description, sampleRate, numberOfChannels: channels } }
                : undefined
            )
            position += frames
          }
          source.close()
        })
      )
      for (let i = 0; i < 28; i++) {
        context.fillStyle = i < 12 ? '#99352b' : '#317848'
        context.fillRect(0, 0, width, height)
        await video.add(i / 10, 0.1)
      }
      video.close()
      await audioDone
      await fixture.finalize()
      const original = new File([target.buffer], 'generated.webm', { type: 'video/webm' })
      const before = await inputBytes(original)
      const recipe = { width, height, name: original.name, edit: { trim: { start, end }, Exposure: 1 } }
      const decoderSupported = AudioDecoder.isConfigSupported
      let opened = 0
      let closed = 0

      // Only the codec boundary is injected. Real Opus decoding, the photo
      // renderer, compositor, packet source and container muxer all run.
      AudioDecoder.isConfigSupported = async (config) => ({ config, supported: false })
      async function* encode(blocks, { channels, signal, onInfo }) {
        opened++
        try {
          let submitted = 0
          async function* withExtraPadding() {
            for await (const pcm of blocks) {
              submitted += pcm.length / channels
              yield pcm
            }
            // Include a full coded packet of trailing padding so the muxer
            // must omit a whole packet and describe only the remainder.
            yield new Float32Array(960 * channels)
          }
          const { packets, leading, coded } = await browserEncode(withExtraPadding(), channels, signal)
          const info = { sampleRate, channels, prime: { leading, trailing: coded - leading - submitted } }
          await onInfo(info)
          yield* packets
          return { ...info, inputFrames: submitted, codedFrames: coded }
        } finally {
          closed++
        }
      }
      let result, cancellation, emptyTrack
      const controller = new AbortController()
      try {
        result = await exportVideo(original, recipe, { format: 'video/webm' }, { encode })
        try {
          await exportVideo(
            original,
            { ...recipe, edit: { trim: { start, end: 0.35 } } },
            { format: 'video/webm' },
            { encode }
          )
        } catch (error) {
          emptyTrack = error.message
        }
        async function* interrupt(blocks, { signal }) {
          opened++
          try {
            for await (const _ of blocks) {
              controller.abort(Error('fixture cancellation'))
              signal.throwIfAborted()
            }
          } finally {
            closed++
          }
        }
        try {
          await exportVideo(
            original,
            recipe,
            { format: 'video/webm', signal: controller.signal },
            { encode: interrupt }
          )
        } catch (error) {
          cancellation = error === controller.signal.reason
        }
      } finally {
        AudioDecoder.isConfigSupported = decoderSupported
      }

      function power(samples, startFrame, frames, frequency) {
        let real = 0,
          imaginary = 0
        for (let i = startFrame; i < startFrame + frames; i++) {
          const phase = (2 * Math.PI * frequency * i) / sampleRate
          real += samples[i] * Math.cos(phase)
          imaginary += samples[i] * Math.sin(phase)
        }
        return Math.hypot(real, imaginary) / frames
      }
      async function inspectAudio(track) {
        const config = await track.getDecoderConfig()
        const description = new Uint8Array(config.description)
        const header = new DataView(description.buffer)
        const leading = header.getUint16(10, true)
        header.setUint16(10, 0, true) // Independently inspect the coded PCM before container trimming.
        const channels = config.numberOfChannels
        const planes = Array.from({ length: channels }, () => [])
        let decoderError
        const decoder = new AudioDecoder({
          output(data) {
            try {
              for (let channel = 0; channel < channels; channel++) {
                const samples = new Float32Array(data.numberOfFrames)
                data.copyTo(samples, { planeIndex: channel, format: 'f32-planar' })
                planes[channel].push(...samples)
              }
            } finally {
              data.close()
            }
          },
          error(error) {
            decoderError = error
          }
        })
        const sink = new media.EncodedPacketSink(track)
        let first, last
        try {
          decoder.configure({ ...config, description })
          for await (const packet of sink.packets()) {
            first ??= packet
            last = packet
            decoder.decode(packet.toEncodedAudioChunk())
          }
          await decoder.flush()
          if (decoderError) throw decoderError
        } finally {
          if (decoder.state !== 'closed') decoder.close()
        }
        const discard = frame(last.sideData.audioDiscardPadding)
        const audible = planes[0].length - leading - discard
        const frequencies = channels === 1 ? [330, 990] : [440, 880]
        const powers =
          channels === 1
            ? [
                power(planes[0], leading + 240, 4_800, 330),
                power(planes[0], leading + audible - 5_040, 4_800, 990)
              ]
            : planes.map((samples, index) => power(samples, leading + 240, 4_800, frequencies[index]))
        const gapStart = leading + frame(1.42) - delays[1]
        const gapPeak =
          channels === 2
            ? Math.max(
                ...planes.flatMap((samples) => samples.slice(gapStart, gapStart + 2_400).map(Math.abs))
              )
            : null
        return {
          name: await track.getName(),
          language: await track.getLanguageCode(),
          default: (await track.getDisposition()).default,
          channels,
          startFrame: frame(first.timestamp) + leading,
          audible,
          discard,
          powers,
          gapPeak
        }
      }
      async function pixelAtZero(input) {
        const track = await input.getPrimaryVideoTrack()
        const sink = new media.CanvasSink(track)
        const decoded = await sink.getCanvas(0.1)
        return Array.from(decoded.canvas.getContext('2d').getImageData(width >> 1, height >> 1, 1, 1).data)
      }
      const source = makeInput(original),
        output = makeInput(result.blob)
      try {
        const tracks = await output.getAudioTracks()
        const outputVideo = await output.getPrimaryVideoTrack()
        const after = await inputBytes(original)
        return {
          filename: result.filename,
          title: (await output.getMetadataTags()).title,
          originalUnchanged:
            before.length === after.length && before.every((value, index) => value === after[index]),
          sourcePixel: await pixelAtZero(source),
          outputPixel: await pixelAtZero(output),
          paired: tracks.every((track) => track.canBePairedWith(outputVideo)),
          tracks: await Promise.all(tracks.map(inspectAudio)),
          opened,
          closed,
          cancellation,
          emptyTrack,
          expected: {
            delayed: delays[1] - frame(start),
            mono: frame(end) - frame(start),
            stereo: frame(end) - delays[1]
          }
        }
      } finally {
        output.dispose()
        source.dispose()
      }
    })
    assert.equal(evidence.filename, 'generated.webm')
    assert.equal(evidence.title, 'Generated multitrack fixture')
    assert.equal(evidence.originalUnchanged, true)
    assert.equal(evidence.paired, true)
    assert.ok(evidence.outputPixel[0] > evidence.sourcePixel[0] + 15, JSON.stringify(evidence))
    assert.equal(evidence.cancellation, true)
    assert.match(evidence.emptyTrack, /Audio track 2: .*no audible samples/)
    assert.equal(evidence.opened, evidence.closed)
    assert.ok(evidence.opened > 2)
    assert.equal(evidence.tracks.length, 2)
    const [mono, stereo] = evidence.tracks
    assert.deepEqual(
      [mono.name, mono.language, mono.default, mono.channels, mono.startFrame, mono.audible],
      ['Primary mono', 'eng', true, 1, 0, evidence.expected.mono]
    )
    assert.deepEqual(
      [stereo.name, stereo.language, stereo.default, stereo.channels, stereo.startFrame, stereo.audible],
      ['Delayed stereo', 'fra', false, 2, evidence.expected.delayed, evidence.expected.stereo]
    )
    assert.ok(stereo.gapPeak < 0.015, JSON.stringify(stereo))
    for (const track of evidence.tracks) {
      assert.ok(track.discard > 0 && track.discard < 960, JSON.stringify(track))
      assert.ok(
        track.powers.every((power) => power > 0.11),
        JSON.stringify(track)
      )
    }
  }
)
