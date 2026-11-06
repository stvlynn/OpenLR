import { audioTrimFrames } from './audio-timing.js'
import { decodeNativeAac } from './native-audio.js'
import { openOpusDecoder } from './opus-decoder.js'
import { EncodedPacketSink, OGG, parseOpusTocByte } from './vendor/mediabunny/mediabunny.mjs'

const aacPacketFrames = 1024
const opusSampleRate = 48000

function samplePosition(seconds, sampleRate) {
  const frame = Math.round(seconds * sampleRate)
  if (!Number.isSafeInteger(frame)) throw Error('Invalid audio packet timestamp')
  return frame
}

// Each observed anchor may be quantized by half a source tick. The range of
// residuals across a continuous run must fit in one tick. Coded frame counts
// determine its spacing, including within a lace with unequal packet lengths.
function packetClock(sampleRate, resolution) {
  const tick = sampleRate / resolution
  let next, low, high
  return {
    start(timestamp) {
      const observed = timestamp * sampleRate
      const rounded = samplePosition(timestamp, sampleRate)
      if (next !== undefined) {
        const residual = observed - next
        const min = Math.min(low, residual),
          max = Math.max(high, residual)
        const arithmeticError = 4 * Number.EPSILON * Math.max(1, Math.abs(next), Math.abs(observed))
        if (max - min <= tick + arithmeticError) {
          low = min
          high = max
          return next
        }
        if (rounded < next) throw Error('Overlapping coded audio packet timestamps')
      }
      low = high = observed - rounded
      return rounded
    },
    advance(end) {
      if (!Number.isSafeInteger(end)) throw Error('Audio packet ends outside the sample clock')
      next = end
    }
  }
}

async function seekPacket(sink, first, from) {
  let start = from > first.timestamp ? await sink.getKeyPacket(from) : null
  const laceStart = start?.sideData.audioLace
  if (laceStart?.index > 0) {
    // Seek may return an expanded member. The preceding members can carry
    // both required preroll and discard that covers more than one packet.
    start = await sink.getPacket(laceStart.timestamp)
    const resolved = start?.sideData.audioLace
    if (
      resolved?.index !== 0 ||
      resolved.timestamp !== laceStart.timestamp ||
      resolved.count !== laceStart.count
    )
      start = null
  }
  return start
}

async function* packetGroups(sink, start, signal) {
  let group
  for await (const packet of sink.packets(start ?? undefined)) {
    signal?.throwIfAborted()
    const { audioLace, audioDiscardPadding = 0 } = packet.sideData
    if (!audioLace) {
      if (group) throw Error('Incomplete laced audio block')
      yield { timestamp: packet.timestamp, packets: [packet], padding: audioDiscardPadding }
      continue
    }
    const { index, count, timestamp } = audioLace
    if (!Number.isInteger(count) || count < 1 || count > 256) throw Error('Invalid laced audio packet count')
    group ??= { timestamp, count, packets: [], padding: 0 }
    if (index !== group.packets.length || timestamp !== group.timestamp || count !== group.count)
      throw Error('Incomplete laced audio block')
    if (audioDiscardPadding) {
      if ((audioDiscardPadding < 0 ? index !== 0 : index !== count - 1) || group.padding)
        throw Error('Invalid audio discard position in laced block')
      group.padding = audioDiscardPadding
    }
    group.packets.push(packet)
    if (group.packets.length === count) {
      yield group
      group = null
    }
  }
  if (group) throw Error('Incomplete laced audio block')
}

async function* seekWithClock(groups, seek, clock, codec) {
  let reached = false
  for await (const group of groups) {
    if (group.packets[0].sequenceNumber === seek.sequenceNumber) reached = true
    if (reached) {
      yield group
      continue
    }
    let frames = 0
    for (const { data } of group.packets) {
      const length = codec === 'aac' ? aacPacketFrames : parseOpusTocByte(data).durationInSamples
      if (!Number.isInteger(length) || length < 1 || length > 5760)
        throw Error('Invalid coded audio packet duration')
      frames += length
    }
    clock.advance(clock.start(group.timestamp) + frames)
  }
  if (!reached) throw Error('The audio seek packet is missing from its coded timeline')
}

function clipGroup(start, frames, padding, bounds, sampleRate) {
  const discard = samplePosition(padding, sampleRate)
  if (Math.abs(discard) > frames) throw Error('Audio discard exceeds its coded block')
  return {
    start,
    frames,
    from: Math.max(start + Math.max(0, -discard), bounds.start),
    to: Math.min(start + frames - Math.max(0, discard), bounds.end)
  }
}

function clippedPcm(pcm, start, position, bounds, channels) {
  const from = Math.max(start, position.from),
    to = Math.min(start + pcm.length / channels, position.to)
  if (to <= from) return null
  return {
    startFrame: from - bounds.origin,
    frames: to - from,
    pcm: pcm.subarray((from - start) * channels, (to - start) * channels)
  }
}

async function* opusBlocks(groups, first, bounds, options, openOpus) {
  const { sampleRate, channels, description, clock, signal, ogg } = options
  const decoder = await openOpus({ numberOfChannels: channels, description })
  try {
    if (decoder.sampleRate !== sampleRate || decoder.channels !== channels)
      throw Error('The Opus decoder changed the sample rate or channel count')
    const audible = Math.max(bounds.start, samplePosition(first.timestamp, sampleRate) + decoder.preSkip)
    if (audible >= bounds.end) return
    bounds = { ...bounds, start: audible }
    for await (const group of groups) {
      signal?.throwIfAborted()
      let start = clock.start(group.timestamp)
      if (start >= bounds.end) break
      const samples = group.packets.map((packet) => decoder.decode(packet.data))
      const frames = samples.reduce((total, pcm) => {
        if (!(pcm instanceof Float32Array) || !pcm.length || pcm.length % channels)
          throw Error('Invalid decoded Opus sample block')
        return total + pcm.length / channels
      }, 0)
      // Ogg exposes its final granule discard as a shortened packet duration.
      const padding = ogg
        ? (frames - samplePosition(group.packets[0].duration, sampleRate)) / sampleRate
        : group.padding
      if (ogg && padding < 0) throw Error('Ogg audio duration exceeds the coded packet')
      const position = clipGroup(start, frames, padding, bounds, sampleRate)
      clock.advance(start + frames)
      for (const pcm of samples) {
        signal?.throwIfAborted()
        const result = clippedPcm(pcm, start, position, bounds, channels)
        if (result) yield result
        start += pcm.length / channels
      }
    }
  } finally {
    decoder.close()
  }
}

async function* aacBlocks(groups, bounds, options, decodeAac) {
  const { sampleRate, channels, description, clock, signal } = options
  const positions = []
  let groupOffset = 0
  let sourceDone = false
  async function* encoded() {
    for await (const group of groups) {
      const start = clock.start(group.timestamp)
      if (start >= bounds.end) break
      const frames = group.packets.length * aacPacketFrames
      positions.push(clipGroup(start, frames, group.padding, bounds, sampleRate))
      clock.advance(start + frames)
      for (const packet of group.packets) yield { data: packet.data, frames: aacPacketFrames }
    }
    sourceDone = true
  }
  for await (const { pcm, frames } of decodeAac(encoded(), { sampleRate, channels, description, signal })) {
    signal?.throwIfAborted()
    if (
      !(pcm instanceof Float32Array) ||
      !Number.isInteger(frames) ||
      frames < 1 ||
      pcm.length !== frames * channels
    )
      throw Error('Invalid decoded AAC sample block')
    let offset = 0
    while (offset < frames) {
      const position = positions[0]
      if (!position) throw Error('AAC decoded more frames than its coded audio timeline')
      const count = Math.min(frames - offset, position.frames - groupOffset)
      const slice = pcm.subarray(offset * channels, (offset + count) * channels)
      const result = clippedPcm(slice, position.start + groupOffset, position, bounds, channels)
      if (result) yield result
      offset += count
      groupOffset += count
      if (groupOffset === position.frames) {
        positions.shift()
        groupOffset = 0
      }
    }
  }
  if (!sourceDone || positions.length) throw Error('AAC decoded fewer frames than its coded audio timeline')
}

/**
 * Plan a mono or stereo audio track against the shared A/V trim clock.
 * blocks() yields owned interleaved PCM with absolute output frame positions
 * relative to trim zero. Positive first positions and holes remain explicit.
 */
export async function planAudioTrack(
  track,
  trim,
  { signal, openOpus = openOpusDecoder, decodeAac = decodeNativeAac } = {}
) {
  signal?.throwIfAborted()
  const [codec, config, resolution, preroll, presentation, container] = await Promise.all([
    track.getCodec(),
    track.getDecoderConfig(),
    track.getTimeResolution(),
    track.getPreRollDuration(),
    track.getPresentationRange(),
    track.input.getFormat()
  ])
  signal?.throwIfAborted()
  const { sampleRate, numberOfChannels: channels, description: rawDescription } = config ?? {}
  if ((codec !== 'aac' && codec !== 'opus') || (channels !== 1 && channels !== 2))
    throw Error('Native video audio requires mono or stereo AAC-LC or Opus')
  if (codec === 'opus' && sampleRate !== opusSampleRate) throw Error('Opus requires its 48 kHz sample clock')
  if (!Number.isFinite(resolution) || resolution <= 0 || !Number.isFinite(preroll) || preroll < 0)
    throw Error('The audio track has no usable timing information')
  const description = ArrayBuffer.isView(rawDescription)
    ? new Uint8Array(rawDescription.buffer, rawDescription.byteOffset, rawDescription.byteLength)
    : rawDescription instanceof ArrayBuffer
      ? new Uint8Array(rawDescription)
      : undefined
  const range = audioTrimFrames(trim, sampleRate, presentation)
  return {
    codec,
    sampleRate,
    channels,
    async *blocks() {
      signal?.throwIfAborted()
      if (!range) return
      const sink = new EncodedPacketSink(track)
      const first = await sink.getFirstPacket({ metadataOnly: true })
      signal?.throwIfAborted()
      if (!first) return
      const bounds = { ...range, origin: range.start - range.outputStart }
      const seek = await seekPacket(sink, first, bounds.start / sampleRate - preroll)
      signal?.throwIfAborted()
      const clock = packetClock(sampleRate, resolution)
      // A coarse seek timestamp cannot independently establish a sample
      // phase. Walk earlier coded durations without decoding their PCM.
      const scan = seek && resolution < sampleRate
      let groups = packetGroups(sink, scan ? null : seek, signal)
      if (scan) groups = seekWithClock(groups, seek, clock, codec)
      const options = { sampleRate, channels, description, clock, signal, ogg: container === OGG }
      if (codec === 'opus') yield* opusBlocks(groups, first, bounds, options, openOpus)
      else yield* aacBlocks(groups, bounds, options, decodeAac)
    }
  }
}
