import { aacDescriptionFromCookie } from './audio-config.js'
import { audioMovieTimescale, audioPacketTiming, audioTailFrames } from './audio-timing.js'
import { encodeNativeAudio } from './native-audio.js'

export function desktopAudioEncoder() {
  const bridge = globalThis.mygo
  if (bridge?.platform === 'darwin' && typeof bridge.call === 'function') return encodeNativeAudio
}

export async function planAudioExport(media, input, format, mp4, signal) {
  const tracks = await input.getTracks()
  const audio = new Map()
  const nativeCodec = mp4 ? 'aac' : 'opus'
  // Conversion prefers an exact non-PCM codec. If it finds none, it may
  // otherwise fall back to a different sample rate or number of channels.
  const candidates = format
    .getSupportedAudioCodecs()
    .filter((codec) => media.NON_PCM_AUDIO_CODECS.includes(codec))
  for (const track of tracks) {
    if (!track.isAudioTrack()) continue
    signal?.throwIfAborted()
    const [sampleRate, channels, decodable] = await Promise.all([
      track.getSampleRate(),
      track.getNumberOfChannels(),
      track.canDecode()
    ])
    let exactCodec
    if (decodable) {
      for (const codec of candidates) {
        if (
          await media.canEncodeAudio(codec, {
            sampleRate,
            numberOfChannels: channels,
            quality: media.QUALITY_HIGH
          })
        ) {
          exactCodec = codec
          break
        }
      }
    }
    audio.set(track, { sampleRate, channels, codec: exactCodec ?? nativeCodec, replace: !exactCodec })
  }
  if (![...audio.values()].some(({ replace }) => replace)) return null
  const outputFormat = mp4
    ? new media.Mp4OutputFormat({
        movieTimescale: audioMovieTimescale([...audio.values()].map(({ sampleRate }) => sampleRate))
      })
    : new media.WebMOutputFormat({ timestampScale: 10_000 })
  return { tracks, audio, outputFormat }
}

function trackError(track, message, cause) {
  return Error(`Audio track ${track.number}: ${message}`, { cause })
}

function decoderConfig({ codec, sampleRate, channels }, info) {
  const leading = info?.prime?.leading
  if (
    !Number.isSafeInteger(leading) ||
    leading < 0 ||
    info.sampleRate !== sampleRate ||
    info.channels !== channels
  )
    throw Error('The native audio codec returned inconsistent configuration or priming')
  if (codec === 'aac') {
    return {
      codec: 'mp4a.40.2',
      sampleRate,
      numberOfChannels: channels,
      description: aacDescriptionFromCookie(info.cookie, { sampleRate, channels })
    }
  }
  if (leading > 0xffff) throw Error('Opus priming exceeds the OpusHead field')
  const description = new Uint8Array(19)
  description.set([79, 112, 117, 115, 72, 101, 97, 100, 1, channels]) // OpusHead version 1, mapping family 0
  const header = new DataView(description.buffer)
  header.setUint16(10, leading, true)
  header.setUint32(12, sampleRate, true)
  return { codec: 'opus', sampleRate, numberOfChannels: channels, description }
}

async function* timedPackets(track, format, blocks, first, encode, signal) {
  const outputStart = first.value.startFrame
  let submitted = 0
  let coded = 0
  let info, config, failed
  const pending = []

  async function* continuousPcm() {
    for (let next = first; !next.done; next = await blocks.next()) {
      signal.throwIfAborted()
      const { startFrame, frames, pcm } = next.value
      if (
        !Number.isSafeInteger(startFrame) ||
        startFrame < 0 ||
        !Number.isSafeInteger(frames) ||
        frames < 1 ||
        !(pcm instanceof Float32Array) ||
        pcm.length !== frames * format.channels
      )
        throw Error('The audio timeline returned an invalid PCM block')
      let gap = startFrame - outputStart - submitted
      if (!Number.isSafeInteger(gap) || gap < 0) throw Error('The audio timeline moved backwards')
      while (gap) {
        signal.throwIfAborted()
        const silence = Math.min(gap, 4096)
        submitted += silence
        gap -= silence
        yield new Float32Array(silence * format.channels)
      }
      submitted += frames
      yield pcm
    }
  }

  const encoder = encode(continuousPcm(), {
    ...format,
    signal,
    onInfo(value) {
      info = value
      config = decoderConfig(format, info)
    }
  })
  function packet({ data, frames, before }, tailFrames) {
    const timing = audioPacketTiming({
      sampleRate: format.sampleRate,
      outputStart,
      leadingFrames: info.prime.leading,
      codedBefore: before,
      packetFrames: frames,
      tailFrames
    })
    return { data, ...timing, metadata: before === 0 ? { decoderConfig: config } : undefined }
  }
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await encoder.next()
      if (next.done) {
        const final = next.value
        if (
          !info ||
          final?.prime?.leading !== info.prime.leading ||
          final.inputFrames !== submitted ||
          final.codedFrames !== coded
        )
          throw Error('The native audio codec returned inconsistent final frame counts')
        const tail = audioTailFrames(coded, info.prime.leading, submitted)
        const audibleEnd = coded - tail
        for (const item of pending) {
          if (item.before >= audibleEnd) break
          yield packet(item, Math.max(0, item.before + item.frames - audibleEnd))
        }
        return
      }
      if (!info) throw Error('The native audio codec emitted a packet before its configuration')
      const { data, frames } = next.value
      pending.push({ data, frames, before: coded })
      coded += frames
      // Only publish packets whose whole extent already precedes the known
      // audible end. The retained boundary may later need discard padding.
      while (pending.length && pending[0].before + pending[0].frames < info.prime.leading + submitted) {
        yield packet(pending.shift(), 0)
      }
    }
  } catch (error) {
    failed = true
    if (signal.aborted) throw signal.reason
    throw trackError(track, `could not encode the selected audio (${error.message})`, error)
  } finally {
    try {
      await encoder.return()
    } catch (error) {
      if (!failed) throw error
    }
  }
}

export async function executeAudioExport(
  media,
  { input, output, trim, video, plan, encode, signal, decodeAac }
) {
  const { planAudioTrack } = await import('./audio-track.js')
  const { tracks, audio } = plan
  const abort = new AbortController()
  const cancel = () => abort.abort(signal.reason)
  const groups = new Map(tracks.map((track) => [track, new media.OutputTrackGroup()]))
  for (const [index, track] of tracks.entries()) {
    for (const other of tracks.slice(index + 1)) {
      if (track.canBePairedWith(other)) groups.get(track).pairWith(groups.get(other))
    }
  }
  const replacements = new Map()
  let conversion,
    conversionStopped,
    cancelWork,
    workers = []
  const stopConversion = () => {
    if (conversion && !conversionStopped) {
      conversionStopped = true
      return conversion.cancel()
    }
  }
  const stopWork = () => (cancelWork ??= Promise.allSettled([stopConversion(), output.cancel()]))
  abort.signal.addEventListener('abort', stopWork, { once: true })
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    signal?.throwIfAborted()
    for (const [track, format] of audio) {
      if (!format.replace) continue
      if (
        format.channels < 1 ||
        format.channels > 2 ||
        (format.sampleRate !== 48_000 && (format.codec !== 'aac' || format.sampleRate !== 44_100))
      )
        throw trackError(track, 'the selected format cannot preserve its sample rate and channel count')
      const entry = { source: new media.EncodedAudioPacketSource(format.codec) }
      replacements.set(track, entry)
      try {
        const timeline = await planAudioTrack(track, trim, { signal: abort.signal, decodeAac })
        if (timeline.sampleRate !== format.sampleRate || timeline.channels !== format.channels)
          throw Error('The source track has inconsistent sample rate or channel metadata')
        entry.blocks = timeline.blocks()[Symbol.asyncIterator]()
        const first = await entry.blocks.next()
        if (first.done) throw Error('The selected interval contains no audible samples for this track')
        entry.packets = timedPackets(track, format, entry.blocks, first, encode, abort.signal)
        const [name, language, disposition] = await Promise.all([
          track.getName(),
          track.getLanguageCode(),
          track.getDisposition()
        ])
        entry.metadata = {
          name: name ?? undefined,
          languageCode: /^[a-z]{3}$/.test(language) ? language : undefined,
          disposition,
          group: groups.get(track)
        }
      } catch (error) {
        if (abort.signal.aborted) throw abort.signal.reason
        throw trackError(track, error.message, error)
      }
    }

    abort.signal.throwIfAborted()
    conversion = await media.Conversion.init({
      input,
      output,
      trim,
      composable: true,
      copy: false,
      tracks: 'all',
      video: (track) => ({ ...video(abort.signal), group: groups.get(track) }),
      audio: (track) =>
        replacements.has(track)
          ? { discard: true }
          : { codec: audio.get(track).codec, group: groups.get(track) }
    })
    abort.signal.throwIfAborted()
    const utilized = new Set(conversion.utilizedTracks)
    if (!conversion.isValid || tracks.some((track) => !utilized.has(track) && !replacements.has(track)))
      throw Error('This device cannot encode every source track in the selected video format')
    for (const { source, metadata } of replacements.values()) output.addAudioTrack(source, metadata)
    const tags = { ...(await input.getMetadataTags()) }
    delete tags.creationTime
    if ((await input.getFormat()).mimeType !== output.format.mimeType) delete tags.raw
    output.setMetadataTags(tags)
    abort.signal.throwIfAborted()
    await output.start()

    async function advance(entry, until) {
      while (!entry.done && !(entry.timestamp >= until)) {
        abort.signal.throwIfAborted()
        const next = await entry.packets.next()
        if (next.done) {
          entry.done = true
          entry.source.close()
        } else {
          const { data, timestamp, duration, sideData, metadata } = next.value
          entry.timestamp = timestamp
          await entry.source.add(
            new media.EncodedPacket(data, 'key', timestamp, duration, -1, undefined, sideData),
            metadata
          )
        }
      }
    }

    // Give the muxer concurrent producers in bounded windows. Its output
    // queues cannot grow to the duration of a complete early-finishing track.
    const duration = trim.end - trim.start
    for (let until = 1; ; until++) {
      const limit = until < duration ? until : Infinity
      abort.signal.throwIfAborted()
      workers = [
        conversion.execute({ until: limit }),
        ...Array.from(replacements.values(), (entry) => advance(entry, limit))
      ]
      await Promise.all(workers)
      if (limit === Infinity) break
    }
    abort.signal.throwIfAborted()
    await output.finalize()
    abort.signal.throwIfAborted()
  } catch (error) {
    const primary = abort.signal.aborted ? abort.signal.reason : error
    abort.abort(primary)
    await Promise.allSettled(workers)
    await stopWork()
    // Initialization may have completed after the abort listener ran.
    await Promise.allSettled([stopConversion()])
    throw primary
  } finally {
    signal?.removeEventListener('abort', cancel)
    abort.signal.removeEventListener('abort', stopWork)
    await Promise.allSettled(
      Array.from(replacements.values(), async ({ packets, blocks }) => {
        try {
          await packets?.return()
        } finally {
          await blocks?.return()
        }
      })
    )
  }
}
