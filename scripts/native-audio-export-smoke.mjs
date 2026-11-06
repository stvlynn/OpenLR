import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { serveWorkspace } from '../tests/browser-server.mjs'
import { fixtureBurst, multitrackFixture } from '../tests/fixtures/multitrack-video.mjs'
import { serveMultitrackVideoFixture } from '../tests/fixtures/video.mjs'
import { withNativeWorkspace } from './native-workspace.mjs'

const [executable, ffmpegBin] = process.argv.slice(2)
assert.ok(executable, 'Pass the OpenLR executable and optionally the directory containing FFmpeg and ffprobe')
const { sampleRate, delays, names, languages, title, shortStartFrame, shortFrames } = multitrackFixture

function run(tool, ...args) {
  const command = ffmpegBin
    ? path.join(path.resolve(ffmpegBin), tool + (process.platform === 'win32' ? '.exe' : ''))
    : tool
  return execFileSync(command, args, { maxBuffer: 4 * 1024 * 1024, timeout: 20_000, windowsHide: true })
}
function inspect(file) {
  return JSON.parse(run('ffprobe', '-v', 'error', '-show_streams', '-show_packets', '-of', 'json', file))
}
function decode(file, index, channels, { codedMp4 = false } = {}) {
  const bytes = run(
    'ffmpeg',
    '-v',
    'error',
    ...(codedMp4 ? ['-ignore_editlist', '1'] : []),
    '-i',
    file,
    '-map',
    `0:a:${index}`,
    '-f',
    'f32le',
    'pipe:1'
  )
  assert.equal(bytes.length % (channels * 4), 0)
  const samples = Array.from({ length: channels }, () => new Float32Array(bytes.length / (channels * 4)))
  for (let i = 0; i < samples[0].length; i++) {
    for (let c = 0; c < channels; c++) samples[c][i] = bytes.readFloatLE((i * channels + c) * 4)
  }
  return samples
}

function diagnostic(read) {
  try {
    return read()
  } catch (error) {
    return { error: error.message }
  }
}

async function retainFailure(testCase, error, tools) {
  const { source, file, label, expected, chrome } = testCase
  const failures = path.resolve('.workspace/native-audio-export-failures')
  await mkdir(failures, { recursive: true })
  const retained = await mkdtemp(path.join(failures, path.parse(file).name + '-'))
  const report = { label, expected, chrome, tools, error: error.message }
  for (const generated of [source, file]) {
    try {
      await copyFile(generated, path.join(retained, path.basename(generated)))
    } catch (copyError) {
      if (copyError.code !== 'ENOENT') throw copyError
    }
  }
  const bytes = await readFile(file).catch((readError) => {
    if (readError.code !== 'ENOENT') throw readError
  })
  if (bytes) {
    report.ffprobe = diagnostic(() => {
      const { streams, packets } = inspect(file)
      let audioIndex = 0
      return streams.map(
        ({ index, codec_type, codec_name, sample_rate, channels, time_base, start_pts, duration_ts }) => {
          const result = {
            index,
            codec_type,
            codec_name,
            sample_rate,
            channels,
            time_base,
            start_pts,
            duration_ts
          }
          if (codec_type !== 'audio') return result
          const coded = packets.filter(({ stream_index }) => stream_index === index)
          const boundary = (packet) =>
            packet && {
              pts: packet.pts,
              pts_time: packet.pts_time,
              duration: packet.duration,
              sideData: packet.side_data_list
            }
          return {
            ...result,
            packets: coded.length,
            first: boundary(coded[0]),
            last: boundary(coded.at(-1)),
            rawDecodedFrames: diagnostic(() => decode(file, audioIndex++, channels)[0].length)
          }
        }
      )
    })
    if (file.endsWith('.mp4')) report.mp4AudioEdits = diagnostic(() => readMp4AudioEdits(bytes))
  }
  await writeFile(path.join(retained, 'audio-export-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.error('Generated audio export diagnostics: ' + JSON.stringify(report))
}

function boxes(bytes, [start, end]) {
  const entries = []
  for (let offset = start; offset < end;) {
    const size = bytes.readUInt32BE(offset)
    assert.ok(size >= 8 && offset + size <= end, 'Invalid short-fixture MP4 box extent')
    entries.push({
      type: bytes.toString('ascii', offset + 4, offset + 8),
      payload: [offset + 8, offset + size]
    })
    offset += size
  }
  return entries
}
function box(bytes, parent, type, required = true) {
  const entry = boxes(bytes, parent).find((child) => child.type === type)
  if (required) assert.ok(entry, 'Expected MP4 box ' + type)
  return entry?.payload
}
function readMp4AudioEdits(bytes) {
  const movie = box(bytes, [0, bytes.length], 'moov')
  const [header] = box(bytes, movie, 'mvhd')
  const movieTimescale = bytes.readUInt32BE(header + (bytes[header] === 1 ? 20 : 12))
  const tracks = []
  for (const { type, payload } of boxes(bytes, movie)) {
    if (type !== 'trak') continue
    const media = box(bytes, payload, 'mdia')
    const [handler] = box(bytes, media, 'hdlr')
    if (bytes.toString('ascii', handler + 8, handler + 12) !== 'soun') continue
    const [header] = box(bytes, media, 'mdhd')
    const wideMediaHeader = bytes[header] === 1
    const mediaTimescale = bytes.readUInt32BE(header + (wideMediaHeader ? 20 : 12))
    const mediaDuration = wideMediaHeader
      ? Number(bytes.readBigUInt64BE(header + 24))
      : bytes.readUInt32BE(header + 16)
    const sampleTable = box(bytes, box(bytes, media, 'minf'), 'stbl')
    const [timing, timingEnd] = box(bytes, sampleTable, 'stts')
    const timingCount = bytes.readUInt32BE(timing + 4)
    assert.equal(timing + 8 + timingCount * 8, timingEnd)
    const sampleTiming = Array.from({ length: timingCount }, (_, index) => {
      const position = timing + 8 + index * 8
      return { count: bytes.readUInt32BE(position), duration: bytes.readUInt32BE(position + 4) }
    })
    const edits = box(bytes, payload, 'edts', false)
    const listBox = edits && box(bytes, edits, 'elst', false)
    if (!listBox) {
      tracks.push({ mediaTimescale, mediaDuration, sampleTiming, list: [] })
      continue
    }
    const [edit, end] = listBox
    const version = bytes[edit]
    assert.ok(version === 0 || version === 1)
    const count = bytes.readUInt32BE(edit + 4)
    const step = version === 1 ? 20 : 12
    assert.equal(edit + 8 + count * step, end)
    const list = Array.from({ length: count }, (_, index) => {
      const position = edit + 8 + index * step
      const durationTicks =
        version === 1 ? Number(bytes.readBigUInt64BE(position)) : bytes.readUInt32BE(position)
      const mediaTime =
        version === 1 ? Number(bytes.readBigInt64BE(position + 8)) : bytes.readInt32BE(position + 4)
      const mediaRate = bytes.readInt32BE(position + step - 4) / 0x10000
      return { durationTicks, mediaTime, mediaRate }
    })
    tracks.push({ mediaTimescale, mediaDuration, sampleTiming, version, list })
  }
  return { movieTimescale, tracks }
}
function mp4AudioEdits(bytes, rate) {
  const { movieTimescale, tracks } = readMp4AudioEdits(bytes)
  return tracks.map(({ mediaTimescale, mediaDuration, sampleTiming, list }) => {
    assert.equal(mediaTimescale, rate)
    assert.ok(list.length > 0, 'Expected MP4 audio edit list')
    const [first, next] = list.map(({ durationTicks, mediaTime, mediaRate }) => {
      assert.equal(mediaRate, 1, 'MP4 edit must run at normal rate')
      const frames = (durationTicks * rate) / movieTimescale
      assert.ok(Number.isSafeInteger(frames), 'Movie edit duration must represent whole audio samples')
      return { frames, mediaTime }
    })
    assert.equal(list.length, first.mediaTime < 0 ? 2 : 1)
    if (next) assert.equal(first.mediaTime, -1, 'Delayed track must begin with an empty edit')
    const audible = next ?? first
    assert.ok(audible.mediaTime > 0, 'AAC edit must account for encoder priming')
    assert.ok(
      sampleTiming.length && sampleTiming.every(({ count, duration }) => count > 0 && duration === 1024)
    )
    const codedFrames = sampleTiming.reduce((total, { count, duration }) => total + count * duration, 0)
    assert.equal(mediaDuration, codedFrames, 'Media duration must describe the coded samples')
    return { delay: next ? first.frames : 0, frames: audible.frames, prime: audible.mediaTime, codedFrames }
  })
}

// Compare the independently decoded export against the independently decoded
// input. The fixture bursts identify absolute phase on either side of the trim.
function compareEdges(actual, source, sourceOffset, frames, label) {
  const window = 1056
  return actual.map((samples, channel) => {
    const reference = source[channel]
    return [128, frames - window - 128].map((start, edge) => {
      let best = { score: -1, lag: 0 }
      for (let lag = -192; lag <= 192; lag++) {
        let correlation = 0,
          signal = 0,
          expected = 0
        for (let i = start; i < start + window; i++) {
          const x = samples[i]
          const y = reference[sourceOffset + i + lag] ?? 0
          correlation += x * y
          signal += x * x
          expected += y * y
        }
        const score = correlation / Math.sqrt(signal * expected)
        if (score > best.score) best = { score, lag, rms: Math.sqrt(signal / window) }
      }
      const detail = `${label} channel ${channel + 1}, edge ${edge + 1}: ${JSON.stringify(best)}`
      assert.ok(best.rms > 0.11 && best.score > 0.91, detail)
      assert.ok(Math.abs(best.lag) <= 6, detail)
      return best
    })
  })
}

async function chromeMetadata(page, bytes, rate) {
  return page.evaluate(
    async ({ bytes, rate }) => {
      const data = Uint8Array.from(bytes)
      const { Input, BufferSource, ALL_FORMATS } = await import('/vendor/mediabunny/mediabunny.mjs')
      const input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS })
      try {
        const video = await input.getPrimaryVideoTrack()
        const audio = await input.getAudioTracks()
        const decoded = await new OfflineAudioContext(2, 1, rate).decodeAudioData(data.buffer.slice(0))
        return {
          playablePrimary: [decoded.length, decoded.sampleRate, decoded.numberOfChannels],
          video: [await video.getDisplayWidth(), await video.getDisplayHeight()],
          title: (await input.getMetadataTags()).title,
          tracks: await Promise.all(
            audio.map(async (track) => ({
              name: await track.getName(),
              language: await track.getLanguageCode(),
              default: (await track.getDisposition()).default,
              paired: track.canBePairedWith(video)
            }))
          )
        }
      } finally {
        input.dispose()
      }
    },
    { bytes: [...bytes], rate }
  )
}

function checkAudio(file, bytes, codec, rate, expected, reference) {
  const { streams, packets } = inspect(file)
  const audio = streams.filter(({ codec_type }) => codec_type === 'audio')
  assert.equal(audio.length, expected.length)
  const edits = codec === 'aac' ? mp4AudioEdits(bytes, rate) : null
  if (edits) assert.equal(edits.length, expected.length)
  return audio.map((stream, index) => {
    const { channels, delay, frames, sourceOffset } = expected[index]
    assert.deepEqual(
      [stream.codec_name, Number(stream.sample_rate), stream.channels],
      [codec, rate, channels]
    )
    const samples = decode(file, index, channels, { codedMp4: Boolean(edits) })
    let playable = samples
    if (edits) {
      const edit = edits[index]
      assert.deepEqual([edit.delay, edit.frames], [delay, frames])
      assert.equal(
        samples[0].length,
        edit.codedFrames,
        'Independent AAC decoder must return every coded frame'
      )
      const end = edit.prime + edit.frames
      const tail = edit.codedFrames - end
      assert.ok(tail >= 0 && tail < 1024, 'AAC edit tail must fit within the last coded packet')
      // Apply the raw edit ourselves. FFmpeg's MOV demuxer can mix the
      // delayed movie timeline with the coded-media duration when discarding.
      playable = samples.map((channel) => channel.subarray(edit.prime, end))
    } else {
      const first = packets.find(({ stream_index }) => stream_index === stream.index)
      const skip = first.side_data_list?.find(
        ({ side_data_type }) => side_data_type === 'Skip Samples'
      )?.skip_samples
      assert.ok(Number.isInteger(skip) && skip > 0, 'Independent demuxer must report Opus encoder delay')
      assert.equal(Math.round(Number(first.pts_time) * rate) + skip, delay, 'Opus audible start')
      assert.equal(samples[0].length, frames, 'Independent Opus decoded frame count')
    }
    return {
      delay,
      frames,
      rawDecodedFrames: samples[0].length,
      edges: compareEdges(playable, reference[index], sourceOffset, frames, codec)
    }
  })
}

async function makeAacInput(root, rate, start) {
  const file = path.join(root, 'aac-input.mp4')
  const pcm = path.join(root, 'aac-input.f32')
  const bytes = Buffer.alloc(2 * rate * 2 * 4)
  for (let i = 0; i < 2 * rate; i++) {
    for (const [channel, frequency] of [389, 823].entries()) {
      const head = i - start - 340,
        tail = i - start - shortFrames + 380
      const value =
        0.3 * Math.sin((2 * Math.PI * frequency * i) / rate) +
        fixtureBurst(head, 1373 + channel * 337, rate) -
        fixtureBurst(tail, 1901 + channel * 229, rate)
      bytes.writeFloatLE(value, (i * 2 + channel) * 4)
    }
  }
  await writeFile(pcm, bytes)
  run(
    'ffmpeg',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x4c7cba:s=96x64:r=30:d=2',
    '-f',
    'f32le',
    '-ar',
    String(rate),
    '-ac',
    '2',
    '-i',
    pcm,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movie_timescale',
    String(rate),
    file
  )
  return file
}

async function prepareClip(call, file, startFrame, rate) {
  const added = await call('import', file)
  assert.deepEqual(added.failed, [])
  assert.equal(added.added.length, 1)
  const [id] = added.added
  const trim = { start: startFrame / rate, end: (startFrame + shortFrames) / rate }
  const state = await call('video-trim', '--start', String(trim.start), '--end', String(trim.end))
  assert.equal(state.selected, id)
  assert.deepEqual(state.photos.find((photo) => photo.id === id).edit.trim, trim)
  return call('edit', '--key', 'turn', '--value', '1')
}

async function unchanged(call, state, source, bytes) {
  assert.deepEqual(await readFile(source), bytes)
  const after = await call('state')
  for (const key of ['mode', 'selected', 'selection', 'photos', 'playback'])
    assert.deepEqual(after[key], state[key], key)
}

async function checkOriginal(call, source, bytes) {
  const result = await call(
    'export',
    '--format',
    'original',
    '--output',
    path.join(path.dirname(source), 'original-' + path.basename(source))
  )
  assert.deepEqual(await readFile(result.path), bytes)
}

const tools = Object.fromEntries(
  ['ffmpeg', 'ffprobe'].map((tool) => [tool, run(tool, '-version').toString().split(/\r?\n/)[0]])
)
const server = await serveWorkspace()
let browser
try {
  const oracleChrome = process.env.OPENLR_AUDIO_ORACLE_CHROME
  browser = await chromium.launch(
    oracleChrome ? { executablePath: oracleChrome } : { channel: process.env.CHROME_CHANNEL || 'chrome' }
  )
  tools.chrome = browser.version()
  const page = await browser.newPage()
  await page.route(server.url + '/', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Independent audio export oracle</title>' })
  )
  await serveMultitrackVideoFixture(page)
  await page.goto(server.url)
  const opusBytes = Buffer.from(
    await page.evaluate(async () => {
      const { createMultitrackVideoFixture } = await import('/__fixtures/multitrack-video.mjs')
      return [...(await createMultitrackVideoFixture())]
    })
  )
  const smoke = async ({ root, call, initial }) => {
    assert.deepEqual(initial.photos, [])
    const failures = []
    async function verify(testCase, work) {
      try {
        return await work()
      } catch (error) {
        console.error(`${testCase.label}: ${error.message}`)
        failures.push(error)
        try {
          await retainFailure(testCase, error, tools)
        } catch (diagnosticError) {
          console.error('Could not retain generated audio export diagnostics: ' + diagnosticError.message)
        }
      }
    }
    const opus = path.join(root, 'multitrack.webm')
    await writeFile(opus, opusBytes)
    const reference = [decode(opus, 0, 1), decode(opus, 1, 2)]
    const expected = delays.map((firstFrame, index) => {
      const delay = Math.max(0, firstFrame - shortStartFrame)
      return {
        channels: index + 1,
        delay,
        frames: shortFrames - delay,
        sourceOffset: Math.max(0, shortStartFrame - firstFrame)
      }
    })
    const state = await verify(
      {
        label: 'Multitrack source preparation',
        file: path.join(root, 'trimmed.webm'),
        source: opus,
        expected
      },
      () => prepareClip(call, opus, shortStartFrame, sampleRate)
    )
    if (!state) throw new AggregateError(failures, 'Packaged audio source preparation failed')
    await checkOriginal(call, opus, opusBytes)
    for (const [extension, codec] of [
      ['webm', 'opus'],
      ['mp4', 'aac']
    ]) {
      const testCase = {
        label: `Multitrack ${extension}`,
        file: path.join(root, 'trimmed.' + extension),
        source: opus,
        expected
      }
      await verify(testCase, async () => {
        const result = await call('export', '--format', 'video/' + extension, '--output', testCase.file)
        const bytes = await readFile(result.path)
        const decoded = await chromeMetadata(page, bytes, sampleRate)
        testCase.chrome = decoded
        await unchanged(call, state, opus, opusBytes)
        assert.deepEqual(decoded.playablePrimary, [shortFrames, sampleRate, 1], extension)
        assert.deepEqual(decoded.video, [64, 96], extension)
        assert.equal(decoded.title, title, extension)
        assert.deepEqual(
          decoded.tracks,
          names.map((name, index) => ({
            name,
            language: languages[index],
            default: index === 0,
            paired: true
          })),
          extension
        )
        const evidence = checkAudio(result.path, bytes, codec, sampleRate, expected, reference)
        console.log(
          JSON.stringify({
            nativeAudioExport: `multitrack-${extension}-passed`,
            evidence,
            originalBytes: opusBytes.length
          })
        )
      })
    }

    const aacRate = 44_100,
      aacStart = 21_941
    const aacCase = {
      label: '44.1 kHz AAC input and export',
      file: path.join(root, 'trimmed-44100.mp4'),
      source: path.join(root, 'aac-input.mp4'),
      expected: [{ channels: 2, delay: 0, frames: shortFrames, sourceOffset: aacStart }]
    }
    await verify(aacCase, async () => {
      const aac = await makeAacInput(root, aacRate, aacStart)
      const aacBytes = await readFile(aac)
      const aacReference = [decode(aac, 0, 2)]
      const aacState = await prepareClip(call, aac, aacStart, aacRate)
      await checkOriginal(call, aac, aacBytes)
      const result = await call('export', '--format', 'video/mp4', '--output', aacCase.file)
      const bytes = await readFile(result.path)
      const decoded = await chromeMetadata(page, bytes, aacRate)
      aacCase.chrome = decoded
      await unchanged(call, aacState, aac, aacBytes)
      assert.deepEqual(decoded.playablePrimary, [shortFrames, aacRate, 2])
      assert.deepEqual(decoded.video, [64, 96])
      const evidence = checkAudio(result.path, bytes, 'aac', aacRate, aacCase.expected, aacReference)
      console.log(
        JSON.stringify({
          nativeAudioExport: 'aac-input-44100-passed',
          evidence,
          originalBytes: aacBytes.length
        })
      )
    })
    if (failures.length) throw new AggregateError(failures, 'Packaged audio export verification failed')
  }
  await withNativeWorkspace(executable, smoke, { env: { OPENLR_DIAGNOSTICS: '1' } })
} finally {
  try {
    await browser?.close()
  } finally {
    server.close()
  }
}
