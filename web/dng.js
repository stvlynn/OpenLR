import { decodePhotoLinear, RAW_EXTENSIONS } from './decode.js'
import { exportXmp } from './xmp.js'
import { metadata as readMetadata } from './metadata.js'

export const XYZ_D65_TO_LINEAR_SRGB = [
  3.2409699419, -1.5373831776, -0.4986107603, -0.9692436363, 1.8759675015, 0.0415550574, 0.0556300797,
  -0.2039769589, 1.0569715142
]
const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8, 16: 8, 18: 8 }
const aligned = (value, multiple) => Math.ceil(value / multiple) * multiple

function payload(type, values) {
  if (type === 2) return new TextEncoder().encode(String(values) + '\0')
  if (type === 1) return Uint8Array.from(values)
  const result = new Uint8Array(values.length * sizes[type]),
    view = new DataView(result.buffer)
  for (let i = 0; i < values.length; i++) {
    const offset = i * sizes[type],
      value = values[i]
    if (type === 3) view.setUint16(offset, value, true)
    else if (type === 4) view.setUint32(offset, value, true)
    else if (type === 16 || type === 18) view.setBigUint64(offset, BigInt(value), true)
    else {
      const limit = type === 10 ? 0x7fffffff : 0xffffffff,
        denominator = Math.min(10000000, Math.max(1, Math.floor(limit / Math.max(1, Math.abs(value)))))
      const [n, d] = Array.isArray(value) ? value : [Math.round(value * denominator), denominator]
      if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0 || Math.abs(n) > limit || d > limit)
        throw Error('Metadata value cannot be represented as a DNG rational')
      if (type === 10) {
        view.setInt32(offset, n, true)
        view.setInt32(offset + 4, d, true)
      } else {
        view.setUint32(offset, n, true)
        view.setUint32(offset + 4, d, true)
      }
    }
  }
  return result
}

// This writes the documented TIFF/DNG container directly. No rendered preview is
// accepted as its source: callers must supply the actual linear RAW decoder data.
export function encodeLinearDng(frame, { sourceName = 'source.raw', xmp = '', metadata = {} } = {}) {
  const { width, height, linear } = frame
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    !(linear instanceof Float32Array) ||
    linear.length !== width * height * 3
  )
    throw Error('DNG export requires a decoded linear RAW RGB frame')
  const rows = 256,
    strips = Math.ceil(height / rows),
    stripBytes = Array.from({ length: strips }, (_, i) => width * Math.min(rows, height - i * rows) * 6)
  const totalPixels = width * height * 6
  if (!Number.isSafeInteger(totalPixels))
    throw Error('DNG byte offsets exceed the JavaScript safe integer range')
  const xmpBytes = new TextEncoder().encode(xmp),
    big = totalPixels + xmpBytes.length + strips * 16 + 4096 > 0xffffffff
  const pointerType = big ? 16 : 4,
    headerSize = big ? 16 : 8,
    countSize = big ? 8 : 2,
    entrySize = big ? 20 : 12,
    nextSize = big ? 8 : 4,
    inline = big ? 8 : 4
  const tags = [],
    exif = []
  const add = (list, id, type, values) =>
    list.push({
      id,
      type,
      bytes: payload(type, values),
      count: type === 2 ? new TextEncoder().encode(String(values) + '\0').length : values.length
    })
  add(tags, 254, 4, [0])
  add(tags, 256, 4, [width])
  add(tags, 257, 4, [height])
  add(tags, 258, 3, [16, 16, 16])
  add(tags, 259, 3, [1])
  add(tags, 262, 3, [34892])
  add(
    tags,
    270,
    2,
    'Processed 16-bit camera-white-balanced linear sRGB; demosaiced RAW, not sensor mosaic or 8-bit preview'
  )
  add(tags, 271, 2, 'OpenLR')
  add(tags, 272, 2, 'Linear sRGB RAW')
  add(tags, 273, pointerType, Array(strips).fill(0))
  add(tags, 274, 3, [1])
  add(tags, 277, 3, [3])
  add(tags, 278, 4, [Math.min(rows, height)])
  add(tags, 279, pointerType, stripBytes)
  add(tags, 284, 3, [1])
  add(tags, 305, 2, 'OpenLR linear RAW DNG writer')
  add(tags, 339, 3, [1, 1, 1])
  if (xmpBytes.length) add(tags, 700, 1, xmpBytes)
  add(tags, 50706, 1, [1, 4, 0, 0])
  add(tags, 50707, 1, [1, 1, 0, 0])
  add(tags, 50708, 2, 'OpenLR Linear sRGB RAW')
  add(tags, 50713, 3, [1, 1])
  add(tags, 50714, 5, [0, 0, 0])
  add(tags, 50717, 4, [65535, 65535, 65535])
  add(tags, 50719, 4, [0, 0])
  add(tags, 50720, 4, [width, height])
  add(tags, 50721, 10, XYZ_D65_TO_LINEAR_SRGB)
  add(tags, 50727, 5, [1, 1, 1])
  add(tags, 50728, 5, [1, 1, 1])
  add(tags, 50730, 10, [0])
  add(tags, 50778, 3, [21])
  add(tags, 50827, 2, sourceName)
  add(tags, 50829, 4, [0, 0, height, width])
  if (typeof metadata.ExposureTime === 'number' && metadata.ExposureTime > 0)
    add(exif, 33434, 5, [metadata.ExposureTime])
  if (typeof metadata.FNumber === 'number' && metadata.FNumber > 0) add(exif, 33437, 5, [metadata.FNumber])
  if (Number.isInteger(metadata.ISO) && metadata.ISO > 0 && metadata.ISO <= 65535)
    add(exif, 34855, 3, [metadata.ISO])
  if (typeof metadata.FocalLength === 'number' && metadata.FocalLength > 0)
    add(exif, 37386, 5, [metadata.FocalLength])
  if (metadata.DateTimeOriginal) {
    const date = new Date(metadata.DateTimeOriginal)
    if (Number.isFinite(date.getTime()))
      add(exif, 36867, 2, date.toISOString().slice(0, 19).replaceAll('-', ':').replace('T', ' '))
  }
  if (exif.length) add(tags, 34665, big ? 18 : 4, [0])
  tags.sort((a, b) => a.id - b.id)
  exif.sort((a, b) => a.id - b.id)
  const exifOffset = headerSize + countSize + tags.length * entrySize + nextSize
  if (exif.length) {
    const tag = tags.find((tag) => tag.id === 34665)
    tag.bytes = payload(tag.type, [exifOffset])
  }
  let offset = exifOffset + (exif.length ? countSize + exif.length * entrySize + nextSize : 0)
  for (const tag of [...tags, ...exif])
    if (tag.bytes.length > inline) {
      offset = aligned(offset, big ? 8 : 2)
      tag.offset = offset
      offset += tag.bytes.length
    }
  offset = aligned(offset, big ? 8 : 2)
  const dataStart = offset,
    stripOffsets = []
  for (const bytes of stripBytes) {
    stripOffsets.push(offset)
    offset += bytes
  }
  const stripTag = tags.find((tag) => tag.id === 273)
  stripTag.bytes = payload(pointerType, stripOffsets)
  const prefix = new Uint8Array(dataStart),
    view = new DataView(prefix.buffer)
  prefix.set([73, 73])
  view.setUint16(2, big ? 43 : 42, true)
  if (big) {
    view.setUint16(4, 8, true)
    view.setBigUint64(8, BigInt(headerSize), true)
  } else view.setUint32(4, headerSize, true)
  function writeIFD(list, start) {
    if (big) view.setBigUint64(start, BigInt(list.length), true)
    else view.setUint16(start, list.length, true)
    for (let i = 0; i < list.length; i++) {
      const tag = list[i],
        at = start + countSize + i * entrySize,
        valueAt = at + (big ? 12 : 8)
      view.setUint16(at, tag.id, true)
      view.setUint16(at + 2, tag.type, true)
      if (big) view.setBigUint64(at + 4, BigInt(tag.count), true)
      else view.setUint32(at + 4, tag.count, true)
      if (tag.offset !== undefined) {
        if (big) view.setBigUint64(valueAt, BigInt(tag.offset), true)
        else view.setUint32(valueAt, tag.offset, true)
        prefix.set(tag.bytes, tag.offset)
      } else prefix.set(tag.bytes, valueAt)
    }
  }
  writeIFD(tags, headerSize)
  if (exif.length) writeIFD(exif, exifOffset)
  const parts = [prefix]
  let index = 0
  for (const bytes of stripBytes) {
    const part = new Uint8Array(bytes),
      data = new DataView(part.buffer)
    for (let i = 0; i < bytes / 2; i++, index++) {
      const sample = linear[index]
      if (!Number.isFinite(sample) || sample < 0 || sample > 1)
        throw Error(
          'Linear DNG samples must be normalized RAW values in 0..1; use Radiance export for HDR scene values'
        )
      data.setUint16(i * 2, Math.round(sample * 65535), true)
    }
    parts.push(part)
  }
  return new Blob(parts, { type: 'image/x-adobe-dng' })
}

export async function isDng(file) {
  const header = new DataView(await file.slice(0, 16).arrayBuffer())
  if (header.byteLength < 8) return false
  const byteOrder = header.getUint16(0, false),
    little = byteOrder === 0x4949
  if (!little && byteOrder !== 0x4d4d) return false
  const version = header.getUint16(2, little),
    big = version === 43
  if (version !== 42 && !big) return false
  if (
    big &&
    (header.byteLength < 16 || header.getUint16(4, little) !== 8 || header.getUint16(6, little) !== 0)
  )
    return false
  const offset = big ? Number(header.getBigUint64(8, little)) : header.getUint32(4, little),
    size = big ? 8 : 2,
    entry = big ? 20 : 12
  if (!Number.isSafeInteger(offset) || offset + size > file.size) return false
  const counter = new DataView(await file.slice(offset, offset + size).arrayBuffer()),
    count = big ? Number(counter.getBigUint64(0, little)) : counter.getUint16(0, little)
  if (!Number.isSafeInteger(count) || offset + size + count * entry > file.size) return false
  const entries = new DataView(await file.slice(offset + size, offset + size + count * entry).arrayBuffer())
  for (let i = 0; i < count; i++)
    if (entries.getUint16(i * entry, little) === 50706) {
      const at = i * entry,
        type = entries.getUint16(at + 2, little),
        n = big ? Number(entries.getBigUint64(at + 4, little)) : entries.getUint32(at + 4, little)
      return type === 1 && n === 4 && entries.getUint8(at + (big ? 12 : 8)) === 1
    }
  return false
}

export async function validateDngSource(file) {
  const original = await isDng(file)
  if (!original && !RAW_EXTENSIONS.includes((file.name || '').split('.').pop().toLowerCase()))
    throw Error(
      'DNG export requires an existing DNG or a decodable camera RAW; rendered images are not RAW sources'
    )
  return original
}

export async function exportDng(photo, file) {
  if (await validateDngSource(file))
    return {
      blob: new Blob([file], { type: 'image/x-adobe-dng' }),
      filename: photo.name.replace(/\.[^.]+$/, '') + '.dng',
      mode: 'original-dng'
    }
  const frame = await decodePhotoLinear(file)
  return {
    blob: encodeLinearDng(frame, {
      sourceName: file.name,
      xmp: exportXmp(photo),
      metadata: photo.metadata ?? (await readMetadata(file))
    }),
    filename: photo.name.replace(/\.[^.]+$/, '') + '.dng',
    mode: 'linear-raw-16'
  }
}
