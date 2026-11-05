import pako from './vendor/codecs/pako.js'
import { PNG_SIGNATURE, pngChunk, pngChunks } from './png-container.js'

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

// Explicit RGBA encoding avoids a canvas color conversion after the caller's transform.
// PNG 3: https://www.w3.org/TR/png-3/#11iCCP
export function encodeColorPng(frame, profile, metadata) {
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
  parts.push(...pngMetadataChunks(metadata))
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

function metadataBytes(metadata, name) {
  return metadata?.[name] === undefined ? new Uint8Array() : bytes(metadata[name], name)
}

function exifBytes(metadata) {
  const exif = metadataBytes(metadata, 'exif')
  if (exif.length) {
    const little = exif[0] === 73 && exif[1] === 73,
      big = exif[0] === 77 && exif[1] === 77
    if (
      exif.length < 8 ||
      (!little && !big) ||
      new DataView(exif.buffer, exif.byteOffset, exif.byteLength).getUint16(2, little) !== 42
    )
      throw Error('Exif metadata must begin with a classic TIFF header')
  }
  return exif
}

function pngMetadataChunks(metadata) {
  const exif = exifBytes(metadata),
    xmp = metadataBytes(metadata, 'xmp'),
    result = []
  if (exif.length) {
    if (exif.length > 0x7fffffff) throw Error('Exif metadata exceeds the PNG chunk length')
    result.push(pngChunk('eXIf', exif))
  }
  if (xmp.length) {
    // PNG iTXt: keyword, compression flag/method, language, translated keyword, UTF-8 text.
    const payload = concatenate([text.encode('XML:com.adobe.xmp\0'), Uint8Array.of(0, 0, 0, 0), xmp])
    if (payload.length > 0x7fffffff) throw Error('XMP metadata exceeds the PNG chunk length')
    result.push(pngChunk('iTXt', payload))
  }
  return result
}

// Adds metadata to native-encoded PNG without decoding or recompressing IDAT.
export function embedPngMetadata(input, metadata) {
  const source = bytes(input, 'PNG'),
    chunks = [...pngChunks(source)],
    xmpKeyword = text.encode('XML:com.adobe.xmp\0'),
    parts = [PNG_SIGNATURE]
  if (
    chunks[0]?.type !== 'IHDR' ||
    chunks.at(-1)?.type !== 'IEND' ||
    !chunks.some(({ type }) => type === 'IDAT') ||
    chunks.reduce((size, chunk) => size + chunk.data.length + 12, 8) !== source.length
  )
    throw Error('Incomplete PNG container')
  let inserted = false
  for (const chunk of chunks) {
    if (!inserted && chunk.type === 'IDAT') {
      parts.push(...pngMetadataChunks(metadata))
      inserted = true
    }
    if (
      chunk.type === 'eXIf' ||
      (['iTXt', 'tEXt', 'zTXt'].includes(chunk.type) && startsWith(chunk.data, 0, xmpKeyword))
    )
      continue
    parts.push(pngChunk(chunk.type, chunk.data))
  }
  return concatenate(parts)
}

// ICC embedding convention: APP2 payloads have a 12-byte signature, sequence and count.
// https://archive.color.org/files/technotes/ICC-Technote-ProfileEmbedding.pdf
export function embedJpegProfile(input, profile, metadata) {
  return rewriteJpeg(input, profileBytes(profile), metadata)
}

// Shares the profile marker walker; sRGB canvas output retains its existing ICC.
export function embedJpegMetadata(input, metadata) {
  return rewriteJpeg(input, null, metadata)
}

function rewriteJpeg(input, icc, metadata) {
  const source = bytes(input, 'JPEG'),
    signature = text.encode('ICC_PROFILE\0'),
    exif = text.encode('Exif\0\0'),
    xmp = text.encode('http://ns.adobe.com/xap/1.0/\0'),
    extendedXmp = text.encode('http://ns.adobe.com/xmp/extension/\0'),
    maximumPart = 65535 - 2 - signature.length - 2,
    count = icc ? Math.ceil(icc.length / maximumPart) : 0
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
      (icc && marker === 226 && startsWith(source, payload, signature)) ||
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
  const addMetadata = (signature, payload) => {
    if (!payload.length) return
    if (signature.length + payload.length > 65533)
      throw Error('Metadata exceeds the JPEG APP1 segment length')
    const segment = new Uint8Array(signature.length + payload.length + 4)
    segment.set([255, 225, (segment.length - 2) >>> 8, (segment.length - 2) & 255])
    segment.set(signature, 4)
    segment.set(payload, 4 + signature.length)
    embedded.push(segment)
  }
  addMetadata(exif, exifBytes(metadata))
  addMetadata(xmp, metadataBytes(metadata, 'xmp'))
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

function tiffTag({ id, type, values }) {
  if (!Number.isInteger(id) || id < 0 || id > 65535) throw Error('Invalid TIFF tag number')
  if (type === 2) {
    if (typeof values !== 'string' || /[^\x01-\x7f]/.test(values))
      throw Error('TIFF ASCII fields require ASCII text without embedded NUL')
    const payload = text.encode(values + '\0')
    return { id, type, count: payload.length, payload }
  }
  const size = { 1: 1, 3: 2, 4: 4, 5: 8, 7: 1, 16: 8, 18: 8 }[type]
  if (!size || (!Array.isArray(values) && !ArrayBuffer.isView(values)))
    throw Error('Unsupported TIFF tag values')
  const count = values.length
  if (!Number.isSafeInteger(count) || count < 0) throw Error('Unsupported TIFF tag values')
  const payload = new Uint8Array(count * size),
    view = new DataView(payload.buffer),
    integer = (value, maximum) => {
      if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
        throw Error('TIFF integer is outside its field range')
      return value
    }
  for (let i = 0; i < count; i++) {
    if (type === 5) {
      const pair = values[i]
      if (!Array.isArray(pair) || pair.length !== 2 || pair[1] === 0)
        throw Error('TIFF rational requires a numerator and nonzero denominator')
      view.setUint32(i * 8, integer(pair[0], 0xffffffff), true)
      view.setUint32(i * 8 + 4, integer(pair[1], 0xffffffff), true)
    } else if (size === 1) payload[i] = integer(values[i], 255)
    else if (type === 3) view.setUint16(i * size, integer(values[i], 65535), true)
    else if (type === 4) view.setUint32(i * size, integer(values[i], 0xffffffff), true)
    else view.setBigUint64(i * size, BigInt(integer(values[i], Number.MAX_SAFE_INTEGER)), true)
  }
  return { id, type, count, payload }
}

function tagDirectory(entries) {
  const tags = entries.map(tiffTag).sort((a, b) => a.id - b.id)
  if (tags.some((tag, i) => i && tags[i - 1].id === tag.id)) throw Error('Duplicate TIFF tag')
  return tags
}

// One layout engine serves standalone Exif and image TIFF; all directory offsets
// are relative to the TIFF header, including nested ExifIFD pointers.
function tiffLayout(ifd, exif, big, pixelLength = 0) {
  const inline = big ? 8 : 4,
    headerSize = big ? 16 : 8,
    countSize = big ? 8 : 2,
    entrySize = big ? 20 : 12,
    nextSize = big ? 8 : 4,
    boundary = big ? 8 : 2,
    root = ifd.map((tag) => ({ ...tag })),
    child = exif.map((tag) => ({ ...tag }))
  if (child.length) root.push(tiffTag({ id: 34665, type: big ? 18 : 4, values: [0] }))
  root.sort((a, b) => a.id - b.id)
  if (root.some((tag, i) => i && root[i - 1].id === tag.id))
    throw Error('TIFF Exif directory pointer is owned by the serializer')
  if (!big && (root.length > 65535 || child.length > 65535)) return null
  let offset = headerSize + countSize + root.length * entrySize + nextSize
  const directories = [{ tags: root, offset: headerSize }]
  if (child.length) {
    offset = align(offset, boundary)
    const pointer = root.find((tag) => tag.id === 34665),
      view = new DataView(pointer.payload.buffer)
    if (big) view.setBigUint64(0, BigInt(offset), true)
    else view.setUint32(0, offset, true)
    directories.push({ tags: child, offset })
    offset += countSize + child.length * entrySize + nextSize
  }
  for (const directory of directories)
    for (const tag of directory.tags) {
      if (!big && tag.count > 0xffffffff) return null
      if (tag.payload.length > inline) {
        tag.offset = offset = align(offset, boundary)
        offset += tag.payload.length
      }
    }
  const pixelOffset = align(offset, boundary),
    total = pixelOffset + pixelLength
  if (!Number.isSafeInteger(total)) throw Error('TIFF offsets exceed the JavaScript safe integer range')
  if (!big && total > 0xffffffff) return null
  return { big, inline, headerSize, countSize, entrySize, directories, pixelOffset, total }
}

function writeTiff(layout, data) {
  const { big, headerSize, countSize, entrySize, directories, pixelOffset, total } = layout,
    result = new Uint8Array(total),
    view = new DataView(result.buffer)
  result.set([73, 73])
  view.setUint16(2, big ? 43 : 42, true)
  if (big) {
    view.setUint16(4, 8, true)
    view.setBigUint64(8, BigInt(headerSize), true)
  } else view.setUint32(4, headerSize, true)
  for (const directory of directories) {
    if (big) view.setBigUint64(directory.offset, BigInt(directory.tags.length), true)
    else view.setUint16(directory.offset, directory.tags.length, true)
    for (let i = 0; i < directory.tags.length; i++) {
      const tag = directory.tags[i],
        at = directory.offset + countSize + i * entrySize,
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
  }
  if (data instanceof Uint16Array)
    for (let i = 0; i < data.length; i++) view.setUint16(pixelOffset + i * 2, data[i], true)
  else if (data) result.set(data, pixelOffset)
  return result
}

export function encodeExifTiff({ ifd = [], exif = [] } = {}) {
  const layout = tiffLayout(tagDirectory(ifd), tagDirectory(exif), false)
  if (!layout) throw Error('Exif metadata exceeds classic TIFF offsets or directory counts')
  return writeTiff(layout)
}

// This raster writer deliberately does not accept DNG's linear sensor contract.
// TIFF ICC tag 34675 is UNDEFINED; alpha is unassociated (ExtraSamples = 2).
export function encodeColorTiff(frame, profile, metadata) {
  const data = frameBytes(frame, 0xffffffff, true),
    depth = data instanceof Uint16Array ? 16 : 8,
    icc = profileBytes(profile),
    rows = Math.min(256, frame.height),
    strips = Math.ceil(frame.height / rows),
    stripBytes = Array.from(
      { length: strips },
      (_, i) => frame.width * Math.min(rows, frame.height - i * rows) * 4 * (depth / 8)
    ),
    xmp = metadataBytes(metadata, 'xmp'),
    exif = tagDirectory(metadata?.tiffTags?.exif || []),
    entries = [
      { id: 256, type: 4, values: [frame.width] },
      { id: 257, type: 4, values: [frame.height] },
      { id: 258, type: 3, values: [depth, depth, depth, depth] },
      { id: 259, type: 3, values: [1] },
      { id: 262, type: 3, values: [2] },
      { id: 274, type: 3, values: [1] },
      { id: 277, type: 3, values: [4] },
      { id: 278, type: 4, values: [rows] },
      { id: 284, type: 3, values: [1] },
      { id: 338, type: 3, values: [2] },
      { id: 34675, type: 7, values: icc }
    ],
    owned = new Set([...entries.map((tag) => tag.id), 273, 279, 34665, 700])
  if (metadataBytes(metadata, 'exif').length && !metadata?.tiffTags)
    throw Error('Image TIFF metadata requires structured TIFF tags')
  for (const tag of metadata?.tiffTags?.ifd || []) {
    if ([256, 257, 274].includes(tag.id)) {
      const expected = entries.find((entry) => entry.id === tag.id)
      if (tag.type !== expected.type || tag.values.length !== 1 || tag.values[0] !== expected.values[0])
        throw Error('Metadata dimensions and orientation must match the rendered TIFF')
    } else if (owned.has(tag.id)) throw Error('Metadata cannot replace a TIFF raster tag')
    else entries.push(tag)
  }
  for (const tag of metadata?.tiffTags?.exif || [])
    if (
      [40962, 40963].includes(tag.id) &&
      (tag.type !== 4 ||
        tag.values.length !== 1 ||
        tag.values[0] !== (tag.id === 40962 ? frame.width : frame.height))
    )
      throw Error('Exif dimensions must match the rendered TIFF')
  if (xmp.length) entries.push({ id: 700, type: 1, values: xmp })
  const makeLayout = (big) =>
    tiffLayout(
      tagDirectory([
        ...entries,
        { id: 273, type: big ? 16 : 4, values: Array(strips).fill(0) },
        { id: 279, type: big ? 16 : 4, values: stripBytes }
      ]),
      exif,
      big,
      data.byteLength
    )
  // Use actual directory/payload extent, including metadata, to select BigTIFF.
  const requiresBig = data.byteLength > 0xffffffff || stripBytes.some((size) => size > 0xffffffff),
    layout = (!requiresBig && makeLayout(false)) || makeLayout(true),
    offsets = layout.directories[0].tags.find((tag) => tag.id === 273),
    offsetView = new DataView(offsets.payload.buffer)
  let offset = layout.pixelOffset
  for (let i = 0; i < strips; i++) {
    if (layout.big) offsetView.setBigUint64(i * 8, BigInt(offset), true)
    else offsetView.setUint32(i * 4, offset, true)
    offset += stripBytes[i]
  }
  return writeTiff(layout, data)
}
