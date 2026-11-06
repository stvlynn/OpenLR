import { aacDecoderCookie, aacDescriptionFromCookie } from './audio-config.js'

const aacPacketFrames = 1024
const aacWarmupFrames = 2 * aacPacketFrames
const opusFrameDuration = 20_000
const maxQueue = 4

function microseconds(frames, sampleRate) {
  return Math.round((frames * 1e6) / sampleRate)
}

function encoderConfig({ codec, sampleRate, channels }) {
  return {
    codec: codec === 'aac' ? 'mp4a.40.2' : 'opus',
    sampleRate,
    numberOfChannels: channels,
    bitrate: codec === 'aac' ? 192_000 : 130_000,
    ...(codec === 'aac'
      ? { aac: { format: 'aac' } }
      : { opus: { format: 'opus', frameDuration: opusFrameDuration } })
  }
}

export async function canEncodeBrowserAudio(format) {
  if (typeof AudioEncoder !== 'function') return false
  if (format.codec === 'aac' && typeof AudioDecoder !== 'function') return false
  const requested = encoderConfig(format)
  const { supported, config } = await AudioEncoder.isConfigSupported(requested)
  const exact =
    supported &&
    config?.sampleRate === requested.sampleRate &&
    config.numberOfChannels === requested.numberOfChannels &&
    config.codec === requested.codec
  if (!exact || format.codec !== 'aac') return exact
  const { codec, sampleRate, numberOfChannels } = config
  return (await AudioDecoder.isConfigSupported({ codec, sampleRate, numberOfChannels })).supported
}

function ownedDescription(description) {
  if (ArrayBuffer.isView(description))
    return new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice()
  if (description instanceof ArrayBuffer) return new Uint8Array(description.slice(0))
  throw Error('Browser audio encoder did not report a codec description')
}

export function opusHeadPriming(description, channels) {
  if (
    !(description instanceof Uint8Array) ||
    description.length < 19 ||
    new TextDecoder().decode(description.subarray(0, 8)) !== 'OpusHead' ||
    description[8] > 15 ||
    description[9] !== channels ||
    description[18] !== 0
  )
    throw Error('The Opus encoder returned an invalid identification header')
  return new DataView(description.buffer, description.byteOffset, description.byteLength).getUint16(10, true)
}

// Keep WebCodecs in one export's async iterator. Dequeue, codec errors and
// cancellation can all release a producer waiting for space.
async function* codecOutput(source, { Codec, config, queueSize, submit, signal }) {
  const ready = []
  let wake, failure
  function changed() {
    wake?.()
    wake = undefined
  }
  const codec = new Codec({
    output(value, metadata) {
      ready.push({ value, metadata })
      changed()
    },
    error(error) {
      failure = error
      changed()
    }
  })
  const close = () => {
    if (codec.state !== 'closed') codec.close()
    changed()
  }
  const check = () => {
    signal?.throwIfAborted()
    if (failure) throw failure
  }
  function* drain() {
    check()
    while (ready.length) yield ready.shift()
  }
  codec.addEventListener('dequeue', changed)
  signal?.addEventListener('abort', close, { once: true })
  try {
    check()
    codec.configure(config)
    for await (const input of source) {
      check()
      while (codec[queueSize] >= maxQueue) {
        yield* drain()
        if (codec[queueSize] >= maxQueue)
          await new Promise((resolve) => {
            wake = resolve
          })
        check()
      }
      submit(codec, input)
      yield* drain()
    }
    await codec.flush()
    yield* drain()
  } catch (error) {
    check()
    throw error
  } finally {
    signal?.removeEventListener('abort', close)
    codec.removeEventListener('dequeue', changed)
    close()
    for (const { value } of ready) value.close?.()
  }
}

export async function* decodeBrowserAac(source, { sampleRate, channels, description, signal }) {
  aacDecoderCookie(description, { sampleRate, channels })
  let codedFrames = 0,
    decodedFrames = 0
  for await (const { value } of codecOutput(source, {
    Codec: AudioDecoder,
    config: { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, description },
    queueSize: 'decodeQueueSize',
    signal,
    submit(decoder, { data, frames }) {
      if (frames !== aacPacketFrames) throw Error('Browser AAC requires 1024-frame packets')
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          data,
          timestamp: microseconds(codedFrames, sampleRate),
          duration: microseconds(frames, sampleRate)
        })
      )
      codedFrames += frames
    }
  })) {
    let pcm, frames
    try {
      frames = value.numberOfFrames
      if (
        value.sampleRate !== sampleRate ||
        value.numberOfChannels !== channels ||
        Math.abs(value.timestamp - microseconds(decodedFrames, sampleRate)) > 1
      )
        throw Error('Browser AAC decoder changed the raw audio format or sample origin')
      pcm = new Float32Array(frames * channels)
      value.copyTo(pcm, { planeIndex: 0, format: 'f32' })
    } finally {
      value.close()
    }
    decodedFrames += frames
    yield { pcm, frames }
  }
  if (codedFrames !== decodedFrames)
    throw Error('Browser AAC decoder did not preserve the coded sample count')
  return { codedFrames, decodedFrames }
}

async function* encodePackets(source, format, signal) {
  const { codec, sampleRate, channels } = format
  const opusTiming =
    codec === 'opus' ? (await import('./vendor/mediabunny/mediabunny.mjs')).parseOpusTocByte : null
  let position = 0
  async function* chunks() {
    for await (const pcm of source) {
      signal?.throwIfAborted()
      if (!(pcm instanceof Float32Array) || !pcm.length || pcm.length % channels)
        throw Error('Expected interleaved browser audio PCM')
      const block = aacPacketFrames * channels
      for (let offset = 0; offset < pcm.length; offset += block) yield pcm.subarray(offset, offset + block)
    }
  }
  for await (const { value, metadata } of codecOutput(chunks(), {
    Codec: AudioEncoder,
    config: encoderConfig(format),
    queueSize: 'encodeQueueSize',
    signal,
    submit(encoder, pcm) {
      const frames = pcm.length / channels
      const data = new AudioData({
        data: pcm,
        format: 'f32',
        sampleRate,
        numberOfChannels: channels,
        numberOfFrames: frames,
        timestamp: microseconds(position, sampleRate)
      })
      try {
        encoder.encode(data)
      } finally {
        data.close()
      }
      position += frames
    }
  })) {
    const data = new Uint8Array(value.byteLength)
    value.copyTo(data)
    const frames = opusTiming ? opusTiming(data).durationInSamples : aacPacketFrames
    if (!data.length || !Number.isSafeInteger(frames) || frames < 1 || (opusTiming && frames > 5760))
      throw Error('Browser audio encoder returned an invalid packet duration')
    yield { data, frames, metadata: metadata?.decoderConfig }
  }
}

function outputDescription(metadata, format) {
  if (metadata?.sampleRate !== format.sampleRate || metadata.numberOfChannels !== format.channels)
    throw Error('Browser audio encoder changed the sample rate or channel count')
  const description = ownedDescription(metadata.description)
  if (format.codec === 'aac') {
    // Some WebKit versions report an ES descriptor instead of bare ASC.
    if (description[0] === 0x03) return aacDescriptionFromCookie(description, format)
    aacDecoderCookie(description, format)
  }
  return description
}

// The header and TOC of a small independent encode establish how much silence
// the real stream needs before flush, including when it has no full input block.
async function browserOpusTiming(format, signal) {
  const frames = (format.sampleRate * opusFrameDuration) / 1e6
  const silence = new Float32Array(frames * format.channels)
  for await (const packet of encodePackets([silence], format, signal)) {
    if (packet.frames !== frames) throw Error('Browser Opus encoder changed the requested packet duration')
    const description = outputDescription(packet.metadata, format)
    return { frames, leading: opusHeadPriming(description, format.channels) }
  }
  throw Error('Browser Opus timing probe produced no packets')
}

// Measure this browser's AAC delay at the actual output rate and layout. A
// second, distinct pulse verifies the same offset later in the stream.
async function browserAacPrime(format, signal) {
  const { channels } = format
  const positions = [240, 6144]
  const length = 8192
  const width = 48
  const source = new Float32Array(length * channels)
  for (const [index, position] of positions.entries()) {
    for (let offset = -width; offset <= width; offset++) {
      const sample = 0.7 * Math.exp(-0.5 * (offset / 11) ** 2) * Math.cos(offset * (0.23 + index * 0.13))
      for (let channel = 0; channel < channels; channel++)
        source[(position + offset) * channels + channel] = sample
    }
  }
  // AAC encoders can suppress the first samples while warming up. Feed
  // the same prefix as the real export and measure it as part of priming.
  const warmup = new Float32Array(aacWarmupFrames * channels)
  // Drain delayed output even if flush only finishes the current packet.
  const packets = []
  let description
  for await (const packet of encodePackets(
    [warmup, source, new Float32Array(2 * aacWarmupFrames * channels)],
    format,
    signal
  )) {
    if (packet.metadata) description ??= outputDescription(packet.metadata, format)
    packets.push(packet)
  }
  if (!description) throw Error('Browser AAC priming probe received no codec description')
  const pcm = new Float32Array(packets.length * aacPacketFrames * channels)
  let cursor = 0
  for await (const block of decodeBrowserAac(packets, { ...format, description, signal })) {
    pcm.set(block.pcm, cursor)
    cursor += block.pcm.length
  }
  function pulseLag(position) {
    let best = { score: 0, lag: -1 }
    const maxLag = cursor / channels - position - width - 1
    for (let lag = 0; lag <= maxLag; lag++) {
      let correlation = 0,
        energy = 0,
        reference = 0
      for (let offset = -width; offset <= width; offset++) {
        for (let channel = 0; channel < channels; channel++) {
          const expected = source[(position + offset) * channels + channel]
          const actual = pcm[(position + offset + lag) * channels + channel]
          correlation += actual * expected
          energy += actual * actual
          reference += expected * expected
        }
      }
      const score = correlation / Math.sqrt(energy * reference)
      if (score > best.score) best = { score, lag }
    }
    if (best.score < 0.8) throw Error('Could not measure browser AAC encoder priming')
    return best.lag
  }
  const leading = pulseLag(positions[0])
  if (leading !== pulseLag(positions[1])) throw Error('Browser AAC encoder priming was not consistent')
  return leading
}

export async function* encodeBrowserAudio(source, { signal, onInfo, ...format }) {
  const { codec, sampleRate, channels } = format
  const opus = codec === 'opus' ? await browserOpusTiming(format, signal) : null
  const leading = opus?.leading ?? (await browserAacPrime(format, signal))
  let inputFrames = 0,
    codedFrames = 0,
    info
  async function* pcm() {
    if (codec === 'aac') yield new Float32Array(aacWarmupFrames * channels)
    for await (const data of source) {
      inputFrames += data.length / channels
      yield data
    }
    if (opus && inputFrames) {
      const required = Math.ceil((inputFrames + leading) / opus.frames) * opus.frames
      if (required > inputFrames) yield new Float32Array((required - inputFrames) * channels)
    } else if (codec === 'aac' && leading > aacWarmupFrames)
      yield new Float32Array((leading - aacWarmupFrames) * channels)
  }
  for await (const { data, frames, metadata } of encodePackets(pcm(), format, signal)) {
    if (opus && frames !== opus.frames) throw Error('Browser Opus encoder changed its packet duration')
    if (!info) {
      const description = outputDescription(metadata, format)
      if (opus && opusHeadPriming(description, channels) !== leading)
        throw Error('Browser Opus encoder changed its priming')
      info = { sampleRate, channels, description, prime: { leading } }
      await onInfo?.(info)
    }
    codedFrames += frames
    yield { data, frames }
  }
  if (!info) throw Error('Browser audio encoder produced no packets')
  return { ...info, inputFrames, codedFrames }
}
