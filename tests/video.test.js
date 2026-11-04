import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('video trim, grading, playback and export preserve the audio track and selected frames', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const m = await import('./vendor/mediabunny/mediabunny.mjs')
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 64
    const ctx = canvas.getContext('2d'),
      target = new m.BufferTarget()
    const out = new m.Output({ target, format: new m.WebMOutputFormat() })
    const video = new m.CanvasSource(canvas, { codec: 'vp9', bitrate: 300000 }),
      audio = new m.AudioBufferSource({ codec: 'opus', bitrate: 64000 })
    out.addVideoTrack(video)
    out.addAudioTrack(audio)
    await out.start()
    const tone = new AudioBuffer({ numberOfChannels: 1, length: 48000, sampleRate: 48000 })
    tone
      .getChannelData(0)
      .forEach((_, i, data) => (data[i] = 0.2 * Math.sin((i / 48000) * 440 * 2 * Math.PI)))
    const audioDone = audio.add(tone)
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = i < 5 ? '#777777' : '#173bd0'
      ctx.fillRect(0, 0, 96, 64)
      await video.add(i / 10, 0.1)
    }
    await audioDone
    await out.finalize()
    const file = new File([target.buffer], 'color-bars.webm', { type: 'video/webm' })
    const run = window.openlr.run
    const imported = await run('import', { files: [file] })
    if (imported.failed.length) throw Error(imported.failed[0].error)
    await run('video-seek', { time: 0.55 })
    await run('video-trim', { start: 0.4, end: 0.8 })
    await run('edit', { key: 'Exposure', value: 0.5 })
    await run('edit', { key: 'turn', value: 1 })
    const playback = (await run('state')).playback
    const { blob } = await run('export', { format: 'video/webm' })
    const input = new m.Input({ source: new m.BlobSource(blob), formats: m.ALL_FORMATS })
    try {
      const track = await input.getPrimaryVideoTrack(),
        a = await input.getPrimaryAudioTrack()
      const sample = await new m.CanvasSink(track).getCanvas(0.2)
      const color = Array.from(sample.canvas.getContext('2d').getImageData(1, 1, 1, 1).data)
      return {
        size: [await track.getDisplayWidth(), await track.getDisplayHeight()],
        type: blob.type,
        duration: await input.computeDuration(),
        audio: await a.getCodec(),
        color,
        playback
      }
    } finally {
      input.dispose()
    }
  })
  assert.deepEqual(result.size, [64, 96])
  assert.equal(result.audio, 'opus')
  assert.equal(result.type, 'video/webm')
  assert.ok(Math.abs(result.duration - 0.4) < 0.055, JSON.stringify(result))
  assert.ok(result.color[2] > result.color[0] * 2 && result.color[2] > 210, JSON.stringify(result))
  assert.ok(Math.abs(result.playback.time - 0.4) < 0.025)
})
