import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { serveWorkspace } from '../tests/browser-server.mjs'
import {
  makeVideoFixture,
  videoFixtureSize as sourceSize,
  videoFixtureFrequencies as frequencies
} from '../tests/fixtures/video.mjs'
import { withHostCrashTrace } from './native-crash-trace.mjs'
import { withNativeWorkspace } from './native-workspace.mjs'
import { ownVideoOracle } from './native-video-oracle.mjs'
import { createPostSignalWorkspace } from './post-signal-workspace.mjs'

const [executable, mode] = process.argv.slice(2)
if (
  mode !== undefined &&
  (!['--lldb', '--lldb-workflow', '--post-signal'].includes(mode) || process.platform !== 'darwin')
)
  throw Error('Optional video diagnostic modes require macOS')
if (!executable) throw Error('Pass the path to a built OpenLR executable')
const postSignal =
  mode === '--post-signal'
    ? createPostSignalWorkspace({ directory: process.env.OPENLR_POST_SIGNAL_DIRECTORY })
    : null
const turnedSize = [64, 96],
  trim = { start: 1.2, end: 2.7 }

async function prepareFixture(page, filename) {
  if (filename) {
    try {
      return await readFile(filename)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const bytes = await makeVideoFixture(page)
  if (filename) await writeFile(filename, bytes, { flag: 'wx' })
  return bytes
}

async function decodeStill(page, result) {
  assert.equal(result.mimeType, 'image/png')
  return page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }))
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          context = canvas.getContext('2d')
        context.drawImage(bitmap, 0, 0)
        return {
          size: [canvas.width, canvas.height],
          pixel: Array.from(context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data)
        }
      } finally {
        bitmap.close()
      }
    },
    Array.from(await readFile(result.path))
  )
}

async function decodeClip(page, result) {
  assert.ok(['video/webm', 'video/mp4'].includes(result.mimeType))
  return page.evaluate(
    async ({ bytes, frequencies }) => {
      const m = await import('/vendor/mediabunny/mediabunny.mjs')
      const input = new m.Input({
        source: new m.BufferSource(Uint8Array.from(bytes)),
        formats: m.ALL_FORMATS
      })
      try {
        const videos = await input.getVideoTracks(),
          audios = await input.getAudioTracks()
        if (videos.length !== 1 || audios.length !== 1)
          throw Error(`Expected one video and one audio track, found ${videos.length} and ${audios.length}`)
        const [video] = videos,
          [audio] = audios
        const videoSink = new m.CanvasSink(video),
          audioSink = new m.AudioBufferSink(audio)
        const pixels = []
        for (const time of [0.25, 1.15]) {
          const frame = await videoSink.getCanvas(time)
          if (!frame) throw Error(`No decoded frame at ${time}s`)
          const { canvas } = frame
          pixels.push(
            Array.from(canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data)
          )
        }

        // Correlate decoded PCM with the three fixture tones in two interior windows.
        // This distinguishes the selected audio from silence and audio at the wrong time.
        const windows = [0.2, 1.1].map((start) => ({
          start,
          count: 0,
          power: 0,
          tones: frequencies.map(() => ({ sin: 0, cos: 0 }))
        }))
        let audioDuration = 0
        for await (const { buffer, timestamp } of audioSink.buffers()) {
          const samples = buffer.getChannelData(0)
          audioDuration += buffer.duration
          for (let i = 0; i < samples.length; i++) {
            const time = timestamp + i / buffer.sampleRate
            const window = windows.find(({ start }) => time >= start && time < start + 0.1)
            if (!window) continue
            window.count++
            window.power += samples[i] ** 2
            frequencies.forEach((frequency, index) => {
              const phase = 2 * Math.PI * frequency * time
              window.tones[index].sin += samples[i] * Math.sin(phase)
              window.tones[index].cos += samples[i] * Math.cos(phase)
            })
          }
        }
        return {
          size: [await video.getDisplayWidth(), await video.getDisplayHeight()],
          videoCodec: await video.getCodec(),
          audioCodec: await audio.getCodec(),
          duration: await input.computeDuration(),
          audioDuration,
          pixels,
          signal: windows.map(({ count, power, tones }) => ({
            rms: Math.sqrt(power / count),
            amplitude: tones.map(({ sin, cos }) => (2 * Math.hypot(sin, cos)) / count)
          }))
        }
      } finally {
        input.dispose()
      }
    },
    { bytes: Array.from(await readFile(result.path)), frequencies }
  )
}

function near(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, got ${actual}`
  )
}

async function playableAudio(page, file) {
  return page.evaluate(
    async (bytes) => {
      const context = new OfflineAudioContext(2, 1, 48000)
      const decoded = await context.decodeAudioData(Uint8Array.from(bytes).buffer)
      return { frames: decoded.length, sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels }
    },
    Array.from(await readFile(file))
  )
}

function checkSignal(decoded) {
  for (const [index, { rms, amplitude }] of decoded.signal.entries()) {
    assert.ok(rms > 0.08 && rms < 0.22, `Decoded audio level in window ${index}: ${rms}`)
    assert.ok(amplitude[index + 1] > 0.12, `Expected tone missing in window ${index}: ${amplitude}`)
    assert.ok(
      amplitude.every((value, tone) => tone === index + 1 || value < 0.04),
      `Unexpected tone in window ${index}: ${amplitude}`
    )
  }
}

function checkColor(pixel, channel, label) {
  assert.equal(pixel[3], 255, label)
  assert.ok(
    pixel[channel] > 130 && pixel.slice(0, 3).every((value, index) => index === channel || value < 100),
    `${label}: unexpected pixel ${pixel}`
  )
}

const server = await serveWorkspace()
let oracle,
  primaryFailure = false
try {
  const oracleChrome = process.env.OPENLR_VIDEO_PROBE_CHROME
  const owner = await chromium.launchServer({
    ...(oracleChrome
      ? { executablePath: oracleChrome }
      : { channel: process.env.CHROME_CHANNEL || 'chrome' }),
    host: '127.0.0.1'
  })
  oracle = ownVideoOracle(owner)
  const browser = await chromium.connect(owner.wsEndpoint(), { timeout: 45_000 })
  console.log(JSON.stringify({ nativeVideoBrowser: browser.version() }))
  async function prepareOracle() {
    const page = await browser.newPage()
    // Use Chrome for the fixture and artifact decoder in a page without OpenLR application code.
    await page.route(server.url + '/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Video oracle</title>' })
    )
    await page.goto(server.url)
    console.log(JSON.stringify({ nativeVideoSetup: 'fixture-pending' }))
    const bytes = await prepareFixture(page, process.env.OPENLR_VIDEO_PROBE_FIXTURE)
    return { page, bytes }
  }
  const timer = new AbortController()
  const { page, bytes } = await Promise.race([
    prepareOracle(),
    delay(45_000, undefined, { signal: timer.signal }).then(() => {
      throw Error('The independent browser did not prepare the video fixture within 45 seconds')
    })
  ]).finally(() => timer.abort())
  console.log(JSON.stringify({ nativeVideoSetup: 'fixture-ready', bytes: bytes.length }))
  const verifyWorkflow = async ({ root, call, initial, pid }) => {
    const clip = path.join(root, 'clip.webm')
    await writeFile(clip, bytes)

    assert.deepEqual(initial.photos, [])
    const imported = await call('import', clip)
    assert.deepEqual(imported.failed, [])
    assert.equal(imported.added.length, 1)
    const [id] = imported.added
    const sought = await call('video-seek', '--time', '0.35')
    assert.equal(sought.selected, id)
    assert.equal(sought.mode, 'detail')
    assert.equal(sought.playback.playing, false)
    near(sought.playback.time, 0.35, 0.025, 'Initial seek')
    near(sought.playback.duration, 3, 0.05, 'Source duration')
    const red = await decodeStill(page, await call('preview', '--output', path.join(root, 'red.png')))
    assert.deepEqual(red.size, sourceSize)
    checkColor(red.pixel, 0, 'Initial preview')

    const started = (await call('video-play')).playback
    assert.equal(started.playing, true)
    let advanced = started
    const deadline = Date.now() + 5000
    while (advanced.playing && advanced.time < started.time + 0.15 && Date.now() < deadline) {
      await delay(50)
      advanced = (await call('state')).playback
    }
    assert.ok(advanced.playing && advanced.time >= started.time + 0.15, JSON.stringify({ started, advanced }))
    const paused = (await call('video-pause')).playback
    assert.equal(paused.playing, false)
    assert.ok(paused.time >= advanced.time, JSON.stringify({ started, advanced, paused }))
    assert.deepEqual((await call('state')).playback, paused)
    // WKWebView can rewind after pause returns, even without another frame read.
    await delay(2000)
    const settledPause = (await call('state')).playback
    assert.equal(settledPause.playing, false)
    near(settledPause.time, paused.time, 0.0001, 'Paused playhead after idle')

    await assert.rejects(call('video-toggle', '--photoId', id + '-stale'), /selected photo changed/)
    await assert.rejects(
      call('video-seek', '--time', '1.5', '--photoId', id + '-stale'),
      /selected photo changed/
    )
    await assert.rejects(
      call('video-trim', '--start', '1', '--end', '2', '--photoId', id + '-stale'),
      /selected photo changed/
    )
    assert.deepEqual((await call('state')).playback, settledPause)
    assert.equal((await call('video-toggle', '--photoId', id)).playback.playing, true)
    assert.equal((await call('video-toggle', '--photoId', id)).playback.playing, false)

    const trimmed = await call(
      'video-trim',
      '--start',
      String(trim.start),
      '--end',
      String(trim.end),
      '--photoId',
      id
    )
    assert.deepEqual(trimmed.photos.find((photo) => photo.id === id).edit.trim, trim)
    assert.equal(trimmed.playback.playing, false)
    near(trimmed.playback.time, trim.start, 0.025, 'Trim start seek')
    const green = await decodeStill(page, await call('preview', '--output', path.join(root, 'green.png')))
    checkColor(green.pixel, 1, 'Trim-start preview')
    await call('edit', '--key', 'turn', '--value', '1')
    const blueSeek = await call('video-seek', '--time', '2.35', '--photoId', id)
    near(blueSeek.playback.time, 2.35, 0.025, 'Blue frame seek')
    const blue = await decodeStill(page, await call('preview', '--output', path.join(root, 'blue.png')))
    assert.deepEqual(blue.size, turnedSize)
    checkColor(blue.pixel, 2, 'Edited preview')

    const beforeStill = await call('state')
    const original = await call(
      'export',
      '--format',
      'original',
      '--output',
      path.join(root, 'original.webm')
    )
    assert.deepEqual(await readFile(original.path), bytes)
    assert.deepEqual(await readFile(clip), bytes)
    const afterOriginal = await call('state')
    for (const key of ['mode', 'selected', 'selection', 'photos', 'playback'])
      assert.deepEqual(afterOriginal[key], beforeStill[key], key)

    await assert.rejects(() => call('save-frame', '--photoId', 'missing-photo'), /selected photo changed/i)
    const saved = await call('save-frame', '--photoId', beforeStill.selected)
    assert.deepEqual(saved.failed, [])
    assert.equal(saved.added.length, 1)
    const withStill = await call('state')
    assert.equal(withStill.selected, saved.added[0])
    assert.equal(withStill.photos.length, 2)
    const savedRow = withStill.photos.find((photo) => photo.id === saved.added[0])
    assert.equal(savedRow.name, `clip-${Math.round(beforeStill.playback.time * 1000)}.png`)
    assert.deepEqual([savedRow.width, savedRow.height], turnedSize)
    assert.deepEqual(savedRow.edit, {})
    const still = await decodeStill(
      page,
      await call('export', '--format', 'original', '--output', path.join(root, 'saved.png'))
    )
    assert.deepEqual(still, blue)

    await call('select', '--id', id)
    const before = await call('video-seek', '--time', String(beforeStill.playback.time))
    assert.equal(before.selected, id)
    assert.deepEqual(before.selection, beforeStill.selection)
    assert.equal(before.mode, beforeStill.mode)
    assert.equal(before.playback.playing, false)
    near(before.playback.time, beforeStill.playback.time, 0.025, 'Restored frame seek')
    assert.deepEqual(
      before.photos.find((photo) => photo.id === id).edit,
      beforeStill.photos.find((photo) => photo.id === id).edit
    )
    console.log(
      JSON.stringify({
        nativeVideo: 'frames-passed',
        playback: { started: started.time, advanced: advanced.time, paused: paused.time },
        previewPixels: [red.pixel, green.pixel, blue.pixel],
        savedFrame: still,
        preservedOriginalBytes: bytes.length
      })
    )

    const verifyExports = async () => {
      const output = await call(
        'export',
        '--format',
        'video/webm',
        '--output',
        path.join(root, 'trimmed.webm')
      )
      const decoded = await decodeClip(page, output)
      const after = await call('state')
      for (const key of ['mode', 'selected', 'selection', 'photos', 'playback'])
        assert.deepEqual(after[key], before[key], key)
      assert.deepEqual(decoded.size, turnedSize)
      assert.equal(decoded.videoCodec, 'vp9')
      assert.equal(decoded.audioCodec, 'opus')
      near(decoded.duration, trim.end - trim.start, 0.055, 'Trimmed container duration')
      near(decoded.audioDuration, trim.end - trim.start, 0.055, 'Decoded PCM duration')
      checkColor(decoded.pixels[0], 1, 'Trimmed first segment')
      checkColor(decoded.pixels[1], 2, 'Trimmed second segment')
      checkSignal(decoded)

      let nativeAudio
      if (process.platform === 'darwin') {
        const mp4 = await call('export', '--format', 'video/mp4', '--output', path.join(root, 'trimmed.mp4'))
        const decodedMp4 = await decodeClip(page, mp4)
        assert.equal(decodedMp4.videoCodec, 'avc')
        assert.equal(decodedMp4.audioCodec, 'aac')
        checkSignal(decodedMp4)
        assert.deepEqual(decodedMp4.size, turnedSize)
        checkColor(decodedMp4.pixels[0], 1, 'MP4 first segment')
        checkColor(decodedMp4.pixels[1], 2, 'MP4 second segment')
        nativeAudio = {}
        for (const [format, result] of [
          ['webm', output],
          ['mp4', mp4]
        ]) {
          const audio = await playableAudio(page, result.path)
          assert.equal(audio.channels, 1, format)
          assert.equal(
            audio.frames,
            Math.round(trim.end * audio.sampleRate) - Math.round(trim.start * audio.sampleRate),
            format
          )
          nativeAudio[format] = audio
        }
        const finalState = await call('state')
        for (const key of ['mode', 'selected', 'selection', 'photos', 'playback'])
          assert.deepEqual(finalState[key], before[key], key)
      }

      console.log(
        JSON.stringify({
          nativeVideo: 'passed',
          playback: { started: started.time, advanced: advanced.time, paused: paused.time },
          previewPixels: [red.pixel, green.pixel, blue.pixel],
          savedFrame: still,
          exported: decoded,
          ...(nativeAudio && { nativeAudio }),
          preservedOriginalBytes: bytes.length
        })
      )
    }
    if (mode === '--lldb') await withHostCrashTrace({ root, pid }, verifyExports)
    else await verifyExports()
  }
  await withNativeWorkspace(
    executable,
    (workspace) =>
      mode === '--lldb-workflow'
        ? withHostCrashTrace(workspace, () => verifyWorkflow(workspace))
        : postSignal
          ? postSignal.wrap(verifyWorkflow)(workspace)
          : verifyWorkflow(workspace),
    {
      env: { DYLD_PRINT_SEGMENTS: '1' },
      ...(postSignal && { launch: postSignal.launch }),
      onCleanup: () => console.log(JSON.stringify({ nativeVideoCleanup: 'confirmed' }))
    }
  )
} catch (error) {
  primaryFailure = true
  throw error
} finally {
  try {
    if (oracle) await oracle.close()
    else console.log(JSON.stringify({ nativeVideoOracleCleanup: 'failed', error: 'OwnershipUnavailable' }))
  } catch (error) {
    if (!primaryFailure) throw error
    console.error('Video oracle cleanup failed: ' + error.message)
  } finally {
    server.close()
  }
}
