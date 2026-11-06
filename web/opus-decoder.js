const sampleRate = 48000
const opusHead = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]

function header(description, channels) {
  if (description == null) return { preSkip: 0, gain: 0 }
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : description instanceof ArrayBuffer
      ? new Uint8Array(description)
      : null
  if (!bytes || bytes.length < 19 || !opusHead.every((value, i) => bytes[i] === value) || bytes[8] > 15) {
    throw Error('Invalid Opus identification header')
  }
  if (bytes[18] !== 0 || bytes[9] !== channels) {
    throw Error('Opus requires matching mono or stereo channel mapping')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { preSkip: view.getUint16(10, true), gain: view.getInt16(16, true) }
}

// One decoder per contiguous packet sequence. Callers feed seek preroll and
// apply preSkip and the container's presentation bounds on their own timeline.
export async function openOpusDecoder({ numberOfChannels: channels, description }) {
  if (channels !== 1 && channels !== 2) throw Error('Opus requires mono or stereo audio')
  const { preSkip, gain } = header(description, channels)
  const { createDecoder, DecoderCtl } = await import('./vendor/opus/index.js')
  let decoder = await createDecoder({ sampleRate, channels })
  try {
    if (gain) decoder.decoderCtl(DecoderCtl.SetGain, gain)
  } catch (error) {
    decoder.free()
    throw error
  }
  return {
    sampleRate,
    channels,
    preSkip,
    decode(packet) {
      if (!decoder) throw Error('Opus decoder is closed')
      if (!(packet instanceof Uint8Array) || packet.length === 0) throw Error('Expected a raw Opus packet')
      return decoder.decodeFloat(packet)
    },
    close() {
      decoder?.free()
      decoder = null
    }
  }
}
