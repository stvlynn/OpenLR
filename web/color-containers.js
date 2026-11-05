import pako from './vendor/codecs/pako.js'

const text = new TextEncoder()
const align = (value, boundary) => Math.ceil(value / boundary) * boundary

function bytes(value, name) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value instanceof Uint8Array || value instanceof Uint8ClampedArray)
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw Error(name + ' must contain bytes')
}

function profileBytes(profile) {
  const result = bytes(profile, 'ICC profile')
  if (!result.length) throw Error('An embedded ICC profile is required')
  return result
}

function frameBytes(frame, maximumDimension, allow16 = false) {
  const { width, height } = frame,
    data = allow16 && frame.data instanceof Uint16Array ? frame.data : bytes(frame.data, 'RGBA pixels'),
    length = width * height * 4
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > maximumDimension ||
    height > maximumDimension ||
    !Number.isSafeInteger(length) ||
    data.length !== length
  )
    throw Error(
      `A complete ${allow16 ? '8-bit or 16-bit' : '8-bit'} RGBA frame with representable dimensions is required`
    )
  return data
}

function concatenate(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  if (!Number.isSafeInteger(length)) throw Error('Container offsets exceed the JavaScript safe integer range')
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

function pngChunk(type, payload) {
  const result = new Uint8Array(payload.length + 12),
    view = new DataView(result.buffer)
  view.setUint32(0, payload.length)
  result.set(text.encode(type), 4)
  result.set(payload, 8)
  let crc = 0xffffffff
  for (let i = 4; i < result.length - 4; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ result[i]) & 255]
  view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0)
  return result
}

// Explicit RGBA encoding avoids a canvas color conversion after the caller's transform.
// PNG 3: https://www.w3.org/TR/png-3/#11iCCP
export function encodeColorPng(frame, profile) {
  const data = frameBytes(frame, 0x7fffffff),
    icc = profileBytes(profile),
    header = new Uint8Array(13),
    view = new DataView(header.buffer),
    stride = frame.width * 4,
    scanlines = new Uint8Array(data.length + frame.height)
  view.setUint32(0, frame.width)
  view.setUint32(4, frame.height)
  header.set([8, 6], 8)
  for (let row = 0; row < frame.height; row++)
    scanlines.set(data.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1)
  const parts = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    pngChunk('IHDR', header),
    pngChunk('iCCP', concatenate([text.encode('OpenLR RGB\0'), Uint8Array.of(0), pako.deflate(icc)]))
  ]
  const compressed = pako.deflate(scanlines)
  // Multiple IDAT chunks bound temporary chunk allocations without limiting image size.
  for (let offset = 0; offset < compressed.length; offset += 1024 * 1024)
    parts.push(pngChunk('IDAT', compressed.subarray(offset, offset + 1024 * 1024)))
  parts.push(pngChunk('IEND', new Uint8Array()))
  return concatenate(parts)
}

function startsWith(data, at, signature) {
  return signature.every((value, index) => data[at + index] === value)
}

// ICC embedding convention: APP2 payloads have a 12-byte signature, sequence and count.
// https://archive.color.org/files/technotes/ICC-Technote-ProfileEmbedding.pdf
export function embedJpegProfile(input, profile) {
  const source = bytes(input, 'JPEG'),
    icc = profileBytes(profile),
    signature = text.encode('ICC_PROFILE\0'),
    exif = text.encode('Exif\0\0'),
    xmp = text.encode('http://ns.adobe.com/xap/1.0/\0'),
    extendedXmp = text.encode('http://ns.adobe.com/xmp/extension/\0'),
    maximumPart = 65535 - 2 - signature.length - 2,
    count = Math.ceil(icc.length / maximumPart)
  if (count > 255) throw Error('ICC profile exceeds the JPEG APP2 sequence capacity')
  if (source[0] !== 255 || source[1] !== 216) throw Error('Invalid JPEG header')
  const segments = []
  let offset = 2,
    ended = false
  while (offset < source.length) {
    const start = offset
    if (source[offset++] !== 255) throw Error('Invalid JPEG marker')
    while (source[offset] === 255) offset++
    const marker = source[offset++]
    if (marker === 217) {
      segments.push({ marker, data: source.subarray(start) })
      ended = true
      break
    }
    if (!marker || marker === 216 || (marker >= 208 && marker <= 215)) throw Error('Invalid JPEG marker')
    if (marker === 1) {
      segments.push({ marker, data: source.subarray(start, offset) })
      continue
    }
    if (offset + 2 > source.length) throw Error('Truncated JPEG segment')
    const length = source[offset] * 256 + source[offset + 1],
      payload = offset + 2
    if (length < 2 || offset + length > source.length) throw Error('Truncated JPEG segment')
    offset += length
    const obsolete =
      (marker === 226 && startsWith(source, payload, signature)) ||
      (marker === 225 && [exif, xmp, extendedXmp].some((id) => startsWith(source, payload, id)))
    if (marker === 218) {
      // Entropy-coded bytes use FF00 stuffing; restart markers remain inside the scan.
      while (offset < source.length) {
        if (source[offset] !== 255) {
          offset++
          continue
        }
        let next = offset + 1
        while (source[next] === 255) next++
        if (source[next] === 0 || (source[next] >= 208 && source[next] <= 215)) offset = next + 1
        else break
      }
    }
    if (!obsolete) segments.push({ marker, data: source.subarray(start, offset) })
  }
  if (!ended) throw Error('JPEG end marker is missing')
  const embedded = []
  for (let index = 0; index < count; index++) {
    const part = icc.subarray(index * maximumPart, (index + 1) * maximumPart),
      segment = new Uint8Array(part.length + 18)
    segment.set([255, 226, (segment.length - 2) >>> 8, (segment.length - 2) & 255])
    segment.set(signature, 4)
    segment.set([index + 1, count], 16)
    segment.set(part, 18)
    embedded.push(segment)
  }
  // Keep JFIF APP0 first. APP14 is retained: its YCbCr/RGB transform is not an ICC profile.
  let first = 0
  while (segments[first]?.marker === 224) first++
  return concatenate([
    source.subarray(0, 2),
    ...segments.slice(0, first).map((segment) => segment.data),
    ...embedded,
    ...segments.slice(first).map((segment) => segment.data)
  ])
}

// This raster-only writer deliberately does not accept DNG's linear sensor contract.
// TIFF ICC tag 34675 is UNDEFINED; alpha is unassociated (ExtraSamples = 2).
export function encodeColorTiff(frame, profile) {
  const data = frameBytes(frame, 0xffffffff, true),
    depth = data instanceof Uint16Array ? 16 : 8,
    sampleBytes = depth / 8,
    icc = profileBytes(profile),
    rows = Math.min(256, frame.height),
    strips = Math.ceil(frame.height / rows),
    stripBytes = Array.from(
      { length: strips },
      (_, i) => frame.width * Math.min(rows, frame.height - i * rows) * 4 * sampleBytes
    ),
    big = data.byteLength + icc.length + strips * 16 + 4096 > 0xffffffff,
    pointerType = big ? 16 : 4,
    inline = big ? 8 : 4,
    headerSize = big ? 16 : 8,
    countSize = big ? 8 : 2,
    entrySize = big ? 20 : 12,
    nextSize = big ? 8 : 4,
    tags = []
  const add = (id, type, values) => {
    const size = type === 3 ? 2 : type === 4 ? 4 : type === 16 ? 8 : 1,
      payload = new Uint8Array(values.length * size),
      view = new DataView(payload.buffer)
    if (size === 1) payload.set(values)
    else
      for (let i = 0; i < values.length; i++) {
        if (type === 3) view.setUint16(i * size, values[i], true)
        else if (type === 4) view.setUint32(i * size, values[i], true)
        else view.setBigUint64(i * size, BigInt(values[i]), true)
      }
    tags.push({ id, type, count: values.length, payload })
  }
  add(256, 4, [frame.width])
  add(257, 4, [frame.height])
  add(258, 3, [depth, depth, depth, depth])
  add(259, 3, [1])
  add(262, 3, [2])
  add(273, pointerType, Array(strips).fill(0))
  add(274, 3, [1])
  add(277, 3, [4])
  add(278, 4, [rows])
  add(279, pointerType, stripBytes)
  add(284, 3, [1])
  add(338, 3, [2])
  add(34675, 7, icc)
  let offset = headerSize + countSize + tags.length * entrySize + nextSize
  for (const tag of tags)
    if (tag.payload.length > inline) {
      tag.offset = offset = align(offset, big ? 8 : 2)
      offset += tag.payload.length
    }
  const pixelOffset = align(offset, big ? 8 : 2),
    total = pixelOffset + data.byteLength
  if (!Number.isSafeInteger(total)) throw Error('TIFF offsets exceed the JavaScript safe integer range')
  const result = new Uint8Array(total),
    view = new DataView(result.buffer),
    offsets = tags.find((tag) => tag.id === 273),
    offsetView = new DataView(offsets.payload.buffer)
  offset = pixelOffset
  for (let i = 0; i < strips; i++) {
    if (big) offsetView.setBigUint64(i * 8, BigInt(offset), true)
    else offsetView.setUint32(i * 4, offset, true)
    offset += stripBytes[i]
  }
  result.set([73, 73])
  view.setUint16(2, big ? 43 : 42, true)
  if (big) {
    view.setUint16(4, 8, true)
    view.setBigUint64(8, BigInt(headerSize), true)
    view.setBigUint64(headerSize, BigInt(tags.length), true)
  } else {
    view.setUint32(4, headerSize, true)
    view.setUint16(headerSize, tags.length, true)
  }
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i],
      at = headerSize + countSize + i * entrySize,
      valueAt = at + (big ? 12 : 8)
    view.setUint16(at, tag.id, true)
    view.setUint16(at + 2, tag.type, true)
    if (big) view.setBigUint64(at + 4, BigInt(tag.count), true)
    else view.setUint32(at + 4, tag.count, true)
    if (tag.offset !== undefined) {
      if (big) view.setBigUint64(valueAt, BigInt(tag.offset), true)
      else view.setUint32(valueAt, tag.offset, true)
      result.set(tag.payload, tag.offset)
    } else result.set(tag.payload, valueAt)
  }
  if (depth === 16) for (let i = 0; i < data.length; i++) view.setUint16(pixelOffset + i * 2, data[i], true)
  else result.set(data, pixelOffset)
  return result
}
