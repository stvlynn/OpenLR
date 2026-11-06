import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { serveWorkspace } from '../tests/browser-server.mjs'

assert.ok(process.argv[2], 'Pass a directory containing FFmpeg and ffprobe')
const tools = path.resolve(process.argv[2]),
  suffix = process.platform === 'win32' ? '.exe' : '',
  output = path.resolve('.workspace/audio-timing-verification')
const mb = await import(
  process.argv[3]
    ? pathToFileURL(path.resolve(process.argv[3])).href
    : '../web/vendor/mediabunny/mediabunny.mjs'
)
const run = (tool, ...args) =>
  execFileSync(path.join(tools, tool + suffix), args, { maxBuffer: 16 * 1024 * 1024 })
const inspect = (file) =>
  JSON.parse(run('ffprobe', '-v', 'error', '-show_streams', '-show_packets', '-of', 'json', file))
const decode = (file, track = '0:a:0') =>
  run('ffmpeg', '-v', 'error', '-i', file, '-map', track, '-f', 'f32le', 'pipe:1')
const input = async (file, library = mb) =>
  new library.Input({ formats: library.ALL_FORMATS, source: new library.BufferSource(await readFile(file)) })
const frames = 9601,
  channels = 2,
  bytesPerFrame = channels * 4,
  movieTimescale = 14_112_000,
  timestampScale = 10_000

await mkdir(output, { recursive: true })
async function reference(codec, rate, extraLead = 0) {
  const source = path.join(output, `${codec}-${rate}.f32`),
    file = path.join(output, `${codec}-${rate}-reference.${codec === 'opus' ? 'webm' : 'mp4'}`),
    samples = Buffer.alloc((frames + extraLead) * bytesPerFrame)
  for (let i = 0; i < frames; i++) {
    const pulse = i >= 300 && i < 325 ? 0.25 : i >= frames - 100 && i < frames - 75 ? -0.25 : 0
    for (const [channel, hz] of [347, 911].entries())
      samples.writeFloatLE(
        0.22 * Math.sin((2 * Math.PI * i * hz) / rate) + pulse,
        ((i + extraLead) * channels + channel) * 4
      )
  }
  await writeFile(source, samples)
  run(
    'ffmpeg',
    '-y',
    '-v',
    'error',
    '-f',
    'f32le',
    '-ar',
    String(rate),
    '-ac',
    String(channels),
    '-i',
    source,
    ...(codec === 'opus'
      ? ['-c:a', 'libopus', '-b:a', '128k']
      : ['-c:a', 'aac', '-b:a', '192k', '-movie_timescale', String(rate)]),
    file
  )
  const {
    streams: [stream],
    packets
  } = inspect(file)
  assert.equal(stream.channels, channels)
  assert.equal(Number(stream.sample_rate), rate)
  const lead = packets[0].side_data_list[0].skip_samples + extraLead
  const packetFrames = codec === 'opus' ? 960 : 1024
  return {
    file,
    codec,
    rate,
    lead,
    packetFrames,
    tail: packets.length * packetFrames - lead - frames,
    extraLead
  }
}

async function addAudio(source, fixture, offset, library, explicitTiming) {
  const { file, rate, lead, packetFrames, tail } = fixture
  const original = await input(file, library)
  try {
    const [track] = await original.getAudioTracks(),
      packets = [],
      decoderConfig = await track.getDecoderConfig()
    for await (const packet of new library.EncodedPacketSink(track).packets()) packets.push(packet)
    for (const [i, packet] of packets.entries()) {
      const sideData = {}
      if (explicitTiming) {
        if (i === 0) sideData.audioPriming = lead / rate
        if (i === 1 && fixture.headDiscard) sideData.audioDiscardPadding = -fixture.headDiscard / rate
        if (i === packets.length - 1) sideData.audioDiscardPadding = tail / rate
      }
      await source.add(
        new library.EncodedPacket(
          packet.data,
          'key',
          (offset + i * packetFrames - lead) / rate,
          packetFrames / rate,
          i,
          undefined,
          sideData
        ),
        i === 0 ? { decoderConfig } : undefined
      )
    }
    source.close()
  } finally {
    original.dispose()
  }
}

async function remux(name, fixture, offsets = [0], { videoFile, library = mb, explicitTiming = true } = {}) {
  const webm = fixture.codec === 'opus',
    file = path.join(output, name + (webm ? '.webm' : '.mp4')),
    target = new library.BufferTarget(),
    format = webm
      ? new library.WebMOutputFormat(explicitTiming ? { timestampScale } : undefined)
      : new library.Mp4OutputFormat(explicitTiming ? { movieTimescale } : undefined),
    writer = new library.Output({ format, target }),
    video = videoFile ? new library.EncodedVideoPacketSource('vp9') : null,
    audio = offsets.map(() => new library.EncodedAudioPacketSource(fixture.codec))
  writer.setMetadataTags({ creationTime: null })
  if (video) writer.addVideoTrack(video, { frameRate: 30 })
  for (const source of audio) writer.addAudioTrack(source)
  await writer.start()
  if (video) {
    const original = await input(videoFile, library)
    try {
      const [track] = await original.getVideoTracks()
      let metadata = { decoderConfig: await track.getDecoderConfig() }
      for await (const packet of new library.EncodedPacketSink(track).packets()) {
        await video.add(packet, metadata)
        metadata = undefined
      }
      video.close()
    } finally {
      original.dispose()
    }
  }
  await Promise.all(
    audio.map((source, index) => addAudio(source, fixture, offsets[index], library, explicitTiming))
  )
  await writer.finalize()
  await writeFile(file, Buffer.from(target.buffer))
  return file
}

function box(bytes, type, start = 0, end = bytes.length) {
  for (let i = start; i < end;) {
    const size = bytes.readUInt32BE(i)
    assert.ok(size >= 8 && i + size <= end, 'Invalid fixture MP4 box extent')
    if (bytes.toString('ascii', i + 4, i + 8) === type) return [i + 8, i + size]
    i += size
  }
  throw Error('Expected MP4 box ' + type)
}

const server = await serveWorkspace()
let browser
try {
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  console.log('Chrome ' + browser.version())
  // Each library reads and writes its own objects for the upstream byte comparison.
  const upstream = await import('mediabunny')
  const page = await browser.newPage()
  await page.goto(server.url)
  for (const fixture of [
    await reference('opus', 48_000),
    await reference('aac', 48_000),
    await reference('aac', 44_100, 1088)
  ]) {
    const { codec, rate, lead, tail, extraLead } = fixture,
      file = await remux(`${codec}-${rate}-exact`, fixture),
      bytes = await readFile(file),
      {
        streams: [track],
        packets
      } = inspect(file)
    assert.equal(track.codec_name, codec)
    assert.equal(track.channels, channels)
    assert.equal(packets[0].side_data_list[0].skip_samples, lead)
    const pcm = decode(file)
    if (codec === 'opus') {
      assert.equal(packets.at(-1).side_data_list[0].discard_padding, tail)
      assert.equal(pcm.length / bytesPerFrame, frames)
      // The independent reference uses 1 ms ticks with a 6.5 ms CodecDelay.
      // Lookups and returned packet timestamps must use the same origin.
      const referenceInput = await input(fixture.file),
        [referenceAudio] = await referenceInput.getAudioTracks(),
        referencePackets = new mb.EncodedPacketSink(referenceAudio),
        firstReference = await referencePackets.getFirstPacket(),
        nextReference = await referencePackets.getNextPacket(firstReference)
      assert.equal(firstReference.timestamp, -0.0065)
      for (const lookup of ['getPacket', 'getKeyPacket']) {
        for (const [offset, expected] of [
          [-0.00025, firstReference],
          [0, nextReference],
          [0.00025, nextReference]
        ]) {
          const observed = await referencePackets[lookup](nextReference.timestamp + offset)
          assert.equal(observed.sequenceNumber, expected.sequenceNumber, `${lookup} at offset ${offset}`)
        }
      }
      referenceInput.dispose()
      const signed = await remux('webm-signed-discard', { ...fixture, headDiscard: 37 }),
        reopened = await input(signed),
        [audio] = await reopened.getAudioTracks(),
        packetSink = new mb.EncodedPacketSink(audio),
        first = await packetSink.getFirstPacket(),
        second = await packetSink.getNextPacket(first),
        last = await packetSink.getPacket(Infinity)
      assert.equal(first.timestamp * rate, -lead)
      assert.equal(Math.round(second.sideData.audioDiscardPadding * rate), -37)
      assert.equal(Math.round(last.sideData.audioDiscardPadding * rate), tail)
      reopened.dispose()
    } else {
      assert.equal(track.duration_ts, frames)
      assert.equal(packets.at(-1).duration, fixture.packetFrames)
    }
    const ref = decode(fixture.file)
    assert.deepEqual(
      pcm.subarray(0, frames * bytesPerFrame),
      ref.subarray(extraLead * bytesPerFrame, (extraLead + frames) * bytesPerFrame)
    )
    const chrome = await page.evaluate(
      async ({ bytes, rate, frames }) => {
        const decoded = await new OfflineAudioContext(2, frames, rate).decodeAudioData(
          Uint8Array.from(bytes).buffer
        )
        return [decoded.length, decoded.numberOfChannels, decoded.sampleRate]
      },
      { bytes: [...bytes], rate, frames }
    )
    assert.deepEqual(chrome, [frames, channels, rate])
    console.log({
      codec,
      rate,
      lead,
      tail,
      chromeFrames: chrome[0],
      ffmpegRawFrames: pcm.length / bytesPerFrame
    })

    if (rate === 48_000) {
      const baseline = await remux(`${codec}-upstream-default`, fixture, [0], {
          library: upstream,
          explicitTiming: false
        }),
        current = await remux(`${codec}-patched-default`, fixture, [0], { explicitTiming: false })
      assert.deepEqual(await readFile(current), await readFile(baseline))
    }

    if (codec === 'aac' && rate === 48_000) {
      const offset = 400 * rate + 19,
        long = await remux('aac-late-edit', fixture, [offset]),
        raw = await readFile(long),
        moov = box(raw, 'moov'),
        trak = box(raw, 'trak', ...moov),
        elst = box(raw, 'elst', ...box(raw, 'edts', ...trak))[0]
      assert.deepEqual(
        [raw[box(raw, 'mvhd', ...moov)[0]], raw[box(raw, 'tkhd', ...trak)[0]], raw[elst]],
        [1, 1, 1]
      )
      assert.equal(raw.readUInt32BE(elst + 4), 2)
      assert.equal(raw.readBigUInt64BE(elst + 8), BigInt((offset * movieTimescale) / rate))
      assert.equal(raw.readBigInt64BE(elst + 16), -1n)
      assert.equal(raw.readBigUInt64BE(elst + 28), BigInt((frames * movieTimescale) / rate))
      assert.equal(raw.readBigInt64BE(elst + 36), BigInt(lead))
      const reopened = await input(long)
      const [audio] = await reopened.getAudioTracks()
      const bounds = await audio.getPresentationRange()
      assert.deepEqual(
        [Math.round(bounds.start * rate), Math.round(bounds.end * rate)],
        [offset, offset + frames]
      )
      reopened.dispose()
    }

    if (codec === 'opus') {
      const sourceVideo = path.join(output, 'source-video.webm'),
        delay = 17_353
      run(
        'ffmpeg',
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=96x64:rate=30',
        '-t',
        '2.4',
        '-c:v',
        'libvpx-vp9',
        '-g',
        '120',
        sourceVideo
      )
      const multitrack = await remux('webm-multitrack', fixture, [0, delay], { videoFile: sourceVideo }),
        observed = inspect(multitrack)
      assert.deepEqual(
        observed.streams.map(({ codec_name }) => codec_name),
        ['vp9', 'opus', 'opus']
      )
      const delayedFirst = observed.packets.find(({ stream_index }) => stream_index === 2)
      assert.equal(Math.round(Number(delayedFirst.pts_time) * rate + lead), delay)
      for (const trackId of ['0:a:0', '0:a:1']) assert.deepEqual(decode(multitrack, trackId), pcm)
      const videoHashes = (file) =>
        run('ffmpeg', '-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', 'pipe:1')
          .toString()
          .split('\n')
          .filter((line) => /^\d+,/.test(line))
          .map((line) => line.split(',').at(-1).trim())
      const actual = videoHashes(multitrack)
      assert.equal(actual.length, 72)
      assert.deepEqual(actual, videoHashes(sourceVideo))
    }
  }
} finally {
  await browser?.close()
  server.close()
}
