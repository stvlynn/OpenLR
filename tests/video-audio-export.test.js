import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { serveMultitrackVideoFixture } from './fixtures/video.mjs'
import { observeVideoEncoder } from '../web/video-import-diagnostics.js'

test('encoder observation samples long exports and retains early queue pressure without payloads', () => {
  assert.equal(observeVideoEncoder(undefined, 0), undefined)
  const records = []
  const observe = observeVideoEncoder(
    (stage, index, details) => records.push({ stage, index, ...details }),
    2
  )
  const report = {
    codec: 'avc1.42400b',
    width: 96,
    height: 64,
    state: 'configured',
    latencyMode: 'quality',
    queueSize: 0,
    submitted: 0,
    output: 0,
    source: 'private-file.mp4',
    description: new Uint8Array([1, 2, 3])
  }
  observe({ ...report, stage: 'configured' })
  for (let submitted = 1; submitted <= 12; submitted++)
    observe({ ...report, stage: 'encoded', submitted, queueSize: Math.max(0, submitted - 8) })
  assert.ok(records.some((record) => record.submitted === 12 && record.queueSize === 4))
  for (let count = 13; count <= 100000; count++) {
    observe({ ...report, stage: 'encoded', submitted: count, output: count - 4, queueSize: 4 })
    observe({ ...report, stage: 'output', submitted: count, output: count - 4, queueSize: 3 })
  }
  observe({ ...report, stage: 'flushed', submitted: 100000, output: 100000 })
  observe({ ...report, stage: 'private-file.mp4' })
  assert.ok(records.length < 100, records.length)
  assert.equal(records.at(-1).stage, 'encoder-flushed')
  assert.equal(records.at(-1).output, 100000)
  assert.ok(records.every((record) => record.index === 2))
  assert.doesNotMatch(JSON.stringify(records), /private|description/)
})

test(
  'video audio fallback preserves a delayed stereo track and trimmed mono samples with an injected encoder',
  { timeout: 90_000 },
  async (t) => {
    const server = await serveWorkspace()
    t.after(server.close)
    const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
    t.after(() => browser.close())
    const page = await browser.newPage()
    await serveMultitrackVideoFixture(page)
    await page.goto(server.url)
    const evidence = await page.evaluate(async () => {
      const media = await import('/vendor/mediabunny/mediabunny.mjs')
      const { exportVideo } = await import('/video.js')
      const { createMultitrackVideoFixture, encodeFixtureOpus, multitrackFixture } =
        await import('/__fixtures/multitrack-video.mjs')
      const { sampleRate, width, height, delays } = multitrackFixture
      const start = 0.18723
      const end = 2.31102
      const frame = (seconds) => Math.round(seconds * sampleRate)
      const inputBytes = (blob) => blob.arrayBuffer().then((buffer) => Array.from(new Uint8Array(buffer)))
      const makeInput = (blob) =>
        new media.Input({ formats: media.ALL_FORMATS, source: new media.BlobSource(blob) })

      const original = new File([await createMultitrackVideoFixture()], 'generated.webm', {
        type: 'video/webm'
      })
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
          const { packets, leading, coded } = await encodeFixtureOpus(withExtraPadding(), channels, signal)
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
      const diagnostics = []
      const previousBridge = globalThis.mygo
      const previousDiagnostics = globalThis.openlrDiagnostics
      let diagnosticBehavior = 'pending'
      const { beginVideoExportTrace } = await import('/video-import-diagnostics.js')
      globalThis.openlrDiagnostics = false
      const disabledTrace = beginVideoExportTrace('video/webm') === undefined
      globalThis.openlrDiagnostics = true
      globalThis.mygo = {
        call(method, report) {
          if (method === 'Desktop.VideoImportDiagnostic') diagnostics.push(JSON.parse(report))
          if (diagnosticBehavior === 'throw') throw Error('Diagnostic bridge threw')
          if (diagnosticBehavior === 'reject') return Promise.reject(Error('Diagnostic bridge rejected'))
          return new Promise(() => {})
        }
      }
      try {
        result = await exportVideo(original, recipe, { format: 'video/webm' }, { encode })
        diagnosticBehavior = 'throw'
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
        diagnosticBehavior = 'reject'
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
        globalThis.mygo = previousBridge
        globalThis.openlrDiagnostics = previousDiagnostics
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
        const observerFailures = []
        for (const behavior of ['throw', 'reject', 'pending']) {
          const input = makeInput(original)
          const target = new media.BufferTarget()
          const converted = new media.Output({ target, format: new media.WebMOutputFormat() })
          let observations = 0
          try {
            const conversion = await media.Conversion.init({
              input,
              output: converted,
              trim: { start: 0, end: 0.5 },
              video: {
                codec: 'vp9',
                forceTranscode: true,
                onEncoderDiagnostic() {
                  observations++
                  if (behavior === 'throw') throw Error('Private observer failure')
                  if (behavior === 'reject') return Promise.reject(Error('Private observer rejection'))
                  return new Promise(() => {})
                }
              },
              audio: { discard: true }
            })
            await conversion.execute()
            const decoded = makeInput(new Blob([target.buffer]))
            try {
              observerFailures.push({ behavior, observations, pixel: await pixelAtZero(decoded) })
            } finally {
              decoded.dispose()
            }
          } finally {
            input.dispose()
          }
        }
        const tracks = await output.getAudioTracks()
        const outputVideo = await output.getPrimaryVideoTrack()
        const after = await inputBytes(original)
        return {
          filename: result.filename,
          title: (await output.getMetadataTags()).title,
          originalUnchanged:
            before.length === after.length && before.every((value, index) => value === after[index]),
          sourcePixel: await pixelAtZero(source),
          observerFailures,
          outputPixel: await pixelAtZero(output),
          paired: tracks.every((track) => track.canBePairedWith(outputVideo)),
          tracks: await Promise.all(tracks.map(inspectAudio)),
          opened,
          closed,
          cancellation,
          diagnostics,
          disabledTrace,
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
    assert.deepEqual(
      evidence.observerFailures.map((result) => result.behavior),
      ['throw', 'reject', 'pending']
    )
    for (const result of evidence.observerFailures) {
      assert.ok(result.observations > 0)
      assert.ok(
        result.pixel.every((value, i) => Math.abs(value - evidence.sourcePixel[i]) < 8),
        JSON.stringify(result)
      )
    }
    assert.equal(evidence.paired, true)
    assert.ok(evidence.outputPixel[0] > evidence.sourcePixel[0] + 15, JSON.stringify(evidence))
    assert.equal(evidence.cancellation, true)
    assert.equal(evidence.disabledTrace, true)
    const traces = Array.from(Map.groupBy(evidence.diagnostics, (record) => record.sequence).values())
    assert.equal(traces.length, 3)
    const stages = traces.map((records) => records.map((record) => record.stage))
    assert.ok(stages[0].includes('output-finalized'))
    assert.ok(stages[0].includes('worker-completed'))
    assert.deepEqual(
      [
        ...new Set(
          traces[0].filter((record) => record.stage === 'worker-completed').map((record) => record.index)
        )
      ].sort(),
      [0, 1, 2]
    )
    assert.ok(stages[0].includes('output-ready'))
    assert.ok(stages[0].includes('encoder-configured'))
    assert.ok(stages[0].includes('encoder-encoded'))
    assert.ok(stages[0].includes('encoder-output'))
    assert.ok(stages[0].includes('encoder-flushed'))
    const configured = traces[0].find((record) => record.stage === 'encoder-configured')
    assert.match(configured.codec, /^vp09\.[0-9.]+$/)
    assert.ok(configured.width > 0 && configured.height > 0)
    assert.equal(configured.state, 'configured')
    const encoded = traces[0].find((record) => record.stage === 'encoder-encoded')
    assert.equal(encoded.submitted, 1)
    assert.ok(Number.isSafeInteger(encoded.queueSize) && encoded.queueSize >= 0)
    assert.ok(stages[1].includes('conversion-failed'))
    assert.ok(stages[2].includes('conversion-failed'))
    assert.ok(traces.every((records) => records.at(-1).stage === 'input-dispose'))
    assert.ok(evidence.diagnostics.every((record) => record.operation === 'export'))
    assert.doesNotMatch(
      JSON.stringify(evidence.diagnostics),
      /generated|fixture cancellation|Diagnostic bridge/
    )
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
