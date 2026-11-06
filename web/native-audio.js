import { aacDecoderCookie } from './audio-config.js'

const transferBytes = 64 * 1024
const aacFrames = 1024
const maxUint32 = 0xffffffff
const emptyChunk = { bytes: new Uint8Array(), packets: [], frames: 0 }

function checkCount(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('Invalid native audio ' + label)
}

function encodeBytes(bytes) {
  if (bytes.length > transferBytes) throw Error('Native audio transfer exceeds 64 KiB')
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(binary)
}

function decodeBytes(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(transferBytes / 3)) {
    throw Error('Invalid native audio transfer')
  }
  const binary = atob(encoded)
  if (binary.length > transferBytes) throw Error('Native audio transfer exceeds 64 KiB')
  return Uint8Array.from(binary, (byte) => byte.charCodeAt(0))
}

function readInfo(info, config) {
  if (info?.sampleRate !== config.sampleRate || info.channels !== config.channels) {
    throw Error('The native audio codec changed the sample rate or channel count')
  }
  const { sampleRate, channels, framesPerPacket, prime } = info
  checkCount(framesPerPacket, 'frames per packet', 0, maxUint32)
  if (config.codec === 'aac' && framesPerPacket !== aacFrames) {
    throw Error('The native AAC codec requires 1024-frame packets')
  }
  if (prime !== null) {
    checkCount(prime?.leading, 'leading frame count', 0, maxUint32)
    checkCount(prime?.trailing, 'trailing frame count', 0, maxUint32)
  }
  return {
    sampleRate,
    channels,
    framesPerPacket,
    prime: prime && { ...prime },
    cookie: decodeBytes(info.cookie)
  }
}

async function* pcmChunks(source, channels, signal) {
  const frameBytes = channels * Float32Array.BYTES_PER_ELEMENT
  const maxSamples = transferBytes / Float32Array.BYTES_PER_ELEMENT
  for await (const pcm of source) {
    signal?.throwIfAborted()
    if (!(pcm instanceof Float32Array) || pcm.length % channels) {
      throw Error('Native audio encoding requires interleaved Float32 PCM with whole frames')
    }
    for (let offset = 0; offset < pcm.length; offset += maxSamples) {
      const length = Math.min(maxSamples, pcm.length - offset)
      const bytes = new Uint8Array(length * Float32Array.BYTES_PER_ELEMENT)
      const view = new DataView(bytes.buffer)
      for (let i = 0; i < length; i++)
        view.setFloat32(i * Float32Array.BYTES_PER_ELEMENT, pcm[offset + i], true)
      yield { bytes, packets: [], frames: bytes.length / frameBytes }
    }
  }
}

async function* aacChunks(source, signal) {
  const buffer = new Uint8Array(transferBytes)
  let size = 0
  let packets = []
  for await (const packet of source) {
    signal?.throwIfAborted()
    const { data, frames } = packet
    if (
      !(data instanceof Uint8Array) ||
      !data.length ||
      data.length > transferBytes ||
      frames !== aacFrames
    ) {
      throw Error('Native AAC decoding requires bounded raw AAC-LC packets of 1024 coded frames')
    }
    if (data.length > transferBytes - size) {
      yield { bytes: buffer.subarray(0, size), packets, frames: packets.length * aacFrames }
      size = 0
      packets = []
    }
    packets.push({ offset: size, size: data.length, frames })
    buffer.set(data, size)
    size += data.length
  }
  if (size) yield { bytes: buffer.subarray(0, size), packets, frames: packets.length * aacFrames }
}

function* readOutput(result, config) {
  const { frames, packets } = result
  const bytes = decodeBytes(result.data)
  if (!Array.isArray(packets)) throw Error('Invalid native audio packet descriptions')
  if (config.decode) {
    if (packets.length || bytes.length !== frames * config.channels * Float32Array.BYTES_PER_ELEMENT) {
      throw Error('Native audio PCM does not match the reported frame and channel counts')
    }
    if (!frames) return
    const pcm = new Float32Array(frames * config.channels)
    const view = new DataView(bytes.buffer)
    for (let i = 0; i < pcm.length; i++) pcm[i] = view.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, true)
    yield { pcm, frames }
    return
  }

  let offset = 0
  let total = 0
  for (const packet of packets) {
    checkCount(packet.size, 'packet size', 1, bytes.length - offset)
    checkCount(packet.frames, 'packet frame count', 1, maxUint32)
    if (packet.offset !== offset || (config.codec === 'aac' && packet.frames !== aacFrames)) {
      throw Error('Invalid native audio packet description')
    }
    offset += packet.size
    total += packet.frames
  }
  if (offset !== bytes.length || total !== frames)
    throw Error('Native audio packet totals do not match the output')
  for (const packet of packets) {
    yield { data: bytes.slice(packet.offset, packet.offset + packet.size), frames: packet.frames }
  }
}

async function* runNativeAudio(source, config, { signal, onInfo }) {
  signal?.throwIfAborted()
  const bridge = globalThis.mygo
  if (typeof bridge?.call !== 'function') throw Error('Native audio requires the desktop codec bridge')
  const invoke = bridge.call.bind(bridge)
  const operation = `Native ${config.codec.toUpperCase()} ${config.decode ? 'decoder' : 'encoder'}`
  const call = async (stage, ...args) => {
    try {
      return await invoke('NativeAudio.' + stage, ...args)
    } catch (cause) {
      throw Error(`${operation} ${stage.toLowerCase()} failed: ${cause?.message ?? cause}`, { cause })
    }
  }
  let id
  let failed = false
  let failure
  try {
    const opened = await call('Open', { ...config, cookie: encodeBytes(config.cookie) })
    if (typeof opened?.id !== 'string' || !opened.id)
      throw Error('The native audio codec returned no stream ID')
    id = opened.id
    signal?.throwIfAborted()
    const initial = readInfo(opened.info, config)
    const currentInfo = async () => {
      const result = await call('Info', id)
      signal?.throwIfAborted()
      const info = readInfo(result, config)
      if (info.framesPerPacket !== initial.framesPerPacket)
        throw Error('The native audio packet format changed')
      return info
    }
    let inputFrames = 0
    let outputFrames = 0
    let reportedInfo = false

    async function* transfer(chunk, final) {
      let consumed = 0
      let input = { data: encodeBytes(chunk.bytes), packets: chunk.packets, final }
      while (true) {
        signal?.throwIfAborted()
        const result = await call('Process', id, input)
        signal?.throwIfAborted()
        const { frames, consumedFrames, needInput, done } = result
        checkCount(frames, 'output frame count', 0, maxUint32)
        checkCount(consumedFrames, 'consumed frame count', 0, chunk.frames - consumed)
        consumed += consumedFrames
        if (typeof needInput !== 'boolean' || typeof done !== 'boolean' || (final ? needInput : done)) {
          throw Error('Unexpected native audio end of stream')
        }
        if (done || needInput) {
          if (consumed !== chunk.frames) throw Error('The native audio codec left input frames unconsumed')
        } else if (!frames && !consumedFrames) {
          throw Error('The native audio codec did not advance')
        }
        outputFrames += frames
        checkCount(outputFrames, 'total output frame count')
        for (const output of readOutput(result, config)) {
          if (onInfo && !reportedInfo) {
            await onInfo(await currentInfo())
            reportedInfo = true
          }
          signal?.throwIfAborted()
          yield output
        }
        if (done || needInput) return
        input = { data: '', packets: [], final: false }
      }
    }

    for await (const chunk of source) {
      inputFrames += chunk.frames
      checkCount(inputFrames, 'total input frame count')
      yield* transfer(chunk, false)
      signal?.throwIfAborted()
    }
    yield* transfer(emptyChunk, true)
    signal?.throwIfAborted()
    if (config.decode) return { codedFrames: inputFrames, decodedFrames: outputFrames }
    return { ...(await currentInfo()), inputFrames, codedFrames: outputFrames }
  } catch (error) {
    failed = true
    failure = signal?.aborted ? signal.reason : error
    throw failure
  } finally {
    if (id) {
      try {
        await call('Close', id)
      } catch (cleanup) {
        if (!failed) throw cleanup
        const primary = failure?.message ?? String(failure)
        throw new AggregateError([failure, cleanup], `${primary}. ${cleanup.message}`, { cause: failure })
      }
    }
  }
}

/** Encode owned packet bytes, with native cookie/prime metadata in the final iterator result. */
export function encodeNativeAudio(source, { codec, sampleRate, channels, signal, onInfo }) {
  if (codec !== 'aac' && codec !== 'opus') throw Error('Unsupported native audio encoder')
  checkCount(sampleRate, 'sample rate', 1, maxUint32)
  checkCount(channels, 'channel count', 1, 2)
  return runNativeAudio(
    pcmChunks(source, channels, signal),
    { codec, decode: false, sampleRate, channels, framesPerPacket: 0, cookie: emptyChunk.bytes },
    { signal, onInfo }
  )
}

/** Decode raw AAC PCM. Container timing and presentation bounds belong to the caller. */
export function decodeNativeAac(source, { sampleRate, channels, description, signal }) {
  checkCount(sampleRate, 'sample rate', 1, maxUint32)
  checkCount(channels, 'channel count', 1, 2)
  const cookie = aacDecoderCookie(description, { sampleRate, channels })
  return runNativeAudio(
    aacChunks(source, signal),
    { codec: 'aac', decode: true, sampleRate, channels, framesPerPacket: aacFrames, cookie },
    { signal }
  )
}
