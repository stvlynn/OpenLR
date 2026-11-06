import { fileURLToPath } from 'node:url'

export function serveMultitrackVideoFixture(page) {
  return page.route('**/__fixtures/multitrack-video.mjs', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      path: fileURLToPath(new URL('./multitrack-video.mjs', import.meta.url))
    })
  )
}

export const videoFixtureSize = [96, 64]
export const videoFixtureFrequencies = [330, 660, 990]
const colors = ['#b42e2e', '#29a549', '#2b3dc6']

export async function makeVideoFixture(page) {
  const encoded = await page.evaluate(
    async ({ videoFixtureSize, colors, videoFixtureFrequencies }) => {
      const m = await import('/vendor/mediabunny/mediabunny.mjs')
      const canvas = new OffscreenCanvas(...videoFixtureSize),
        context = canvas.getContext('2d'),
        target = new m.BufferTarget(),
        output = new m.Output({ target, format: new m.WebMOutputFormat() }),
        video = new m.CanvasSource(canvas, { codec: 'vp9', bitrate: 300000 }),
        audio = new m.AudioBufferSource({ codec: 'opus', bitrate: 64000 })
      output.addVideoTrack(video)
      output.addAudioTrack(audio)
      await output.start()
      const sampleRate = 48000
      const tone = new AudioBuffer({ numberOfChannels: 1, length: sampleRate * colors.length, sampleRate })
      const samples = tone.getChannelData(0)
      for (let i = 0; i < samples.length; i++) {
        const time = i / sampleRate
        samples[i] = 0.2 * Math.sin(2 * Math.PI * videoFixtureFrequencies[Math.floor(time)] * time)
      }
      const audioDone = audio.add(tone)
      for (let i = 0; i < 10 * colors.length; i++) {
        context.fillStyle = colors[Math.floor(i / 10)]
        context.fillRect(0, 0, canvas.width, canvas.height)
        await video.add(i / 10, 0.1)
      }
      await audioDone
      await output.finalize()
      return Array.from(new Uint8Array(target.buffer))
    },
    { videoFixtureSize, colors, videoFixtureFrequencies }
  )
  return Buffer.from(encoded)
}
