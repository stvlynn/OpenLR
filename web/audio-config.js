const aacSampleRates = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350
]
const esTag = 0x03
const decoderConfigTag = 0x04
const decoderSpecificInfoTag = 0x05
const mpeg4Audio = 0x40
const downstreamAudioStream = 0x05 << 2
const decoderConfigSize = 13

function validateAacDescription(description, { sampleRate, channels }) {
  if (!(description instanceof Uint8Array)) throw new TypeError('Expected AAC AudioSpecificConfig bytes')
  let bit = 0
  const end = description.length * 8
  function read(count) {
    if (bit + count > end) throw new Error('Truncated AAC AudioSpecificConfig')
    let value = 0
    for (let i = 0; i < count; i++, bit++) {
      value = (value << 1) | ((description[bit >> 3] >> (7 - (bit & 7))) & 1)
    }
    return value
  }

  if (read(5) !== 2) throw new Error('Native AAC requires AAC-LC')
  const rateIndex = read(4)
  const rate = rateIndex === 15 ? read(24) : aacSampleRates[rateIndex]
  const channelConfig = read(4)
  if (!rate || rate !== sampleRate || channelConfig < 1 || channelConfig > 2 || channelConfig !== channels) {
    throw new Error(
      'AAC AudioSpecificConfig does not match the native sample rate and mono or stereo channel count'
    )
  }
  if (read(1) || read(1) || read(1))
    throw new Error('Native AAC requires independent 1024-frame AAC-LC packets')

  // Common LC encoders explicitly signal that no spectral band replication is present.
  if (end - bit >= 11 && (read(11) !== 0x2b7 || read(5) !== 5 || read(1))) {
    throw new Error('Unsupported AAC AudioSpecificConfig extension')
  }
  if (end - bit > 7 || read(end - bit)) throw new Error('Invalid AAC AudioSpecificConfig padding')
}

function readDescriptor(bytes, offset, limit) {
  if (offset >= limit) throw new Error('Missing AAC cookie descriptor')
  const tag = bytes[offset++]
  let size = 0
  for (let i = 0; i < 4 && offset < limit; i++) {
    const part = bytes[offset++]
    size = (size << 7) | (part & 0x7f)
    if (!(part & 0x80)) {
      if (size > limit - offset) throw new Error('AAC cookie descriptor exceeds its parent')
      return { tag, start: offset, end: offset + size }
    }
  }
  throw new Error('Invalid AAC cookie descriptor length')
}

function findDescriptor(bytes, offset, end, tag) {
  if (offset > end) throw new Error('Truncated AAC cookie descriptor fields')
  let found
  while (offset < end) {
    const descriptor = readDescriptor(bytes, offset, end)
    if (descriptor.tag === tag) {
      if (found) throw new Error('Duplicate AAC cookie descriptor')
      found = descriptor
    }
    offset = descriptor.end
  }
  if (!found) throw new Error('Missing AAC cookie descriptor')
  return found
}

// AudioToolbox emits a raw ES_Descriptor. The container needs its owned AAC description.
export function aacDescriptionFromCookie(cookie, format) {
  if (!(cookie instanceof Uint8Array)) throw new TypeError('Expected AAC cookie bytes')
  const es = readDescriptor(cookie, 0, cookie.length)
  if (es.tag !== esTag || es.end !== cookie.length || es.end - es.start < 3) {
    throw new Error('Invalid AAC cookie elementary stream descriptor')
  }
  const flags = cookie[es.start + 2]
  let child = es.start + 3
  if (flags & 0x80) child += 2 // dependsOn_ES_ID
  if (flags & 0x40) {
    if (child >= es.end) throw new Error('Truncated AAC cookie URL field')
    child += 1 + cookie[child]
  }
  if (flags & 0x20) child += 2 // OCR_ES_Id

  const config = findDescriptor(cookie, child, es.end, decoderConfigTag)
  // AudioToolbox's encoder leaves the reserved low bit clear in its cookie.
  if (
    config.end - config.start < decoderConfigSize ||
    cookie[config.start] !== mpeg4Audio ||
    (cookie[config.start + 1] & 0xfe) !== downstreamAudioStream
  ) {
    throw new Error('Invalid AAC cookie MPEG-4 audio stream descriptor')
  }
  const info = findDescriptor(cookie, config.start + decoderConfigSize, config.end, decoderSpecificInfoTag)
  const description = cookie.subarray(info.start, info.end)
  validateAacDescription(description, format)
  return new Uint8Array(description)
}

// Raw AAC packets arrive with AudioSpecificConfig. AudioToolbox needs its enclosing descriptor.
export function aacDecoderCookie(description, format) {
  validateAacDescription(description, format)
  const configSize = decoderConfigSize + 2 + description.length
  const esSize = 3 + 2 + configSize
  // The supported LC bit fields keep all descriptor lengths below 128 bytes.
  const cookie = new Uint8Array(2 + esSize)
  cookie.set([esTag, esSize, 0, 1, 0, decoderConfigTag, configSize, mpeg4Audio, downstreamAudioStream | 1])
  const info = 7 + decoderConfigSize
  cookie.set([decoderSpecificInfoTag, description.length], info)
  cookie.set(description, info + 2)
  return cookie
}
