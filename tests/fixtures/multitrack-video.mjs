const sampleRate = 48_000
const frame = (seconds) => Math.round(seconds * sampleRate)
export const multitrackFixture = Object.freeze({
  sampleRate,
  width: 96,
  height: 64,
  delays: [0, 27_000],
  counts: [130_560, 94_720],
  names: ['Primary mono', 'Delayed stereo'],
  languages: ['eng', 'fra'],
  title: 'Generated multitrack fixture',
  shortStartFrame: 23_871,
  shortFrames: 9_601
})

export function fixtureBurst(distance, frequency, rate) {
  return 0.16 * Math.exp(-0.5 * (distance / 96) ** 2) * Math.cos((2 * Math.PI * frequency * distance) / rate)
}

export async function encodeFixtureOpus(blocks, channels, signal) {
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

export async function createMultitrackVideoFixture() {
  const media = await import('/vendor/mediabunny/mediabunny.mjs')
  const { width, height, delays, counts, names, languages, title, shortStartFrame, shortFrames } =
    multitrackFixture
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  const target = new media.BufferTarget()
  const fixture = new media.Output({
    target,
    format: new media.WebMOutputFormat({ timestampScale: 10_000 })
  })
  fixture.setMetadataTags({ title })
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
      const head = Math.max(delays[index], shortStartFrame) + 340
      const tail = shortStartFrame + shortFrames - 380
      for (let i = 0; i < counts[index]; i++) {
        const position = i + delays[index]
        const time = position / sampleRate
        for (let channel = 0; channel < channels; channel++) {
          const frequency = index === 0 ? (time < 0.75 ? 330 : time < 1.6 ? 660 : 990) : 440 * (channel + 1)
          // Two small out-of-band bursts identify the short trim edges even
          // when a shift by one period of the steady tone would correlate.
          pcm[i * channels + channel] =
            0.3 * Math.sin(2 * Math.PI * frequency * time) +
            fixtureBurst(position - head, 1471 + channel * 347, sampleRate) -
            fixtureBurst(position - tail, 1901 + channel * 457, sampleRate)
        }
      }
      const { packets, leading, coded, description } = await encodeFixtureOpus([pcm], channels)
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

  return new Uint8Array(target.buffer)
}
