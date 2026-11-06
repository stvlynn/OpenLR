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
import { withNativeWorkspace } from './native-workspace.mjs'

const executable = process.argv[2]
if (!executable) throw Error('Pass the path to a built OpenLR executable')
const turnedSize = [64, 96],
  trim = { start: 1.2, end: 2.7 }
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
  assert.equal(result.mimeType, 'video/webm')
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

function checkColor(pixel, channel, label) {
  assert.equal(pixel[3], 255, label)
  assert.ok(
    pixel[channel] > 130 && pixel.slice(0, 3).every((value, index) => index === channel || value < 100),
    `${label}: unexpected pixel ${pixel}`
  )
}

const server = await serveWorkspace()
let browser
try {
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  const page = await browser.newPage()
  // Use Chrome for the fixture and artifact decoder in a page without OpenLR application code.
  await page.route(server.url + '/', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Video oracle</title>' })
  )
  await page.goto(server.url)
  const bytes = await makeVideoFixture(page)
  await withNativeWorkspace(executable, async ({ root, call, initial }) => {
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

    const trimmed = await call('video-trim', '--start', String(trim.start), '--end', String(trim.end))
    assert.deepEqual(trimmed.photos.find((photo) => photo.id === id).edit.trim, trim)
    assert.equal(trimmed.playback.playing, false)
    near(trimmed.playback.time, trim.start, 0.025, 'Trim start seek')
    const green = await decodeStill(page, await call('preview', '--output', path.join(root, 'green.png')))
    checkColor(green.pixel, 1, 'Trim-start preview')
    await call('edit', '--key', 'turn', '--value', '1')
    const blueSeek = await call('video-seek', '--time', '2.35')
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

    const saved = await call('save-frame')
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

    const output = await call('export', '--format', 'video/webm', '--output', path.join(root, 'trimmed.webm'))
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
    for (const [index, { rms, amplitude }] of decoded.signal.entries()) {
      assert.ok(rms > 0.08 && rms < 0.22, `Decoded audio level in window ${index}: ${rms}`)
      assert.ok(amplitude[index + 1] > 0.12, `Expected tone missing in window ${index}: ${amplitude}`)
      assert.ok(
        amplitude.every((value, tone) => tone === index + 1 || value < 0.04),
        `Unexpected tone in window ${index}: ${amplitude}`
      )
    }

    console.log(
      JSON.stringify({
        nativeVideo: 'passed',
        playback: { started: started.time, advanced: advanced.time, paused: paused.time },
        previewPixels: [red.pixel, green.pixel, blue.pixel],
        savedFrame: still,
        exported: decoded,
        preservedOriginalBytes: bytes.length
      })
    )
  })
} finally {
  try {
    await browser?.close()
  } finally {
    server.close()
  }
}
