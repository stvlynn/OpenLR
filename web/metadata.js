import { EXPORT_METADATA_FIELDS, normalizeCaptureDate } from './export-metadata.js'

const tags = [...EXPORT_METADATA_FIELDS, 'OffsetTimeOriginal', 'SubSecTimeOriginal', 'ISOSpeed']
const utf8 = new TextEncoder()
const string = (value) => (typeof value === 'string' && value.trim() ? value : undefined)
const own = (object, key) => (object && Object.hasOwn(object, key) ? object[key] : undefined)

function xmlValue(value, language = false) {
  if (Array.isArray(value)) {
    value = language ? (value.find((item) => item?.lang === 'x-default') ?? value[0]) : value[0]
  }
  if (value && typeof value === 'object') value = value.value
  if (typeof value !== 'string') return value
  // exifr's XMP reader retains XML entities; decode once, including numeric references.
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name) => {
    if (name[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name] ?? whole
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : whole
  })
}

function namespace(xmp, prefix, uri) {
  const actual = Object.keys(xmp.xmlns ?? {}).find((key) => xmp.xmlns[key] === uri)
  return xmp[actual ?? prefix] ?? {}
}

function normalizedMetadata(exif = {}, xmp = {}) {
  const tiff = namespace(xmp, 'tiff', 'http://ns.adobe.com/tiff/1.0/')
  const camera = namespace(xmp, 'exif', 'http://ns.adobe.com/exif/1.0/')
  const extra = namespace(xmp, 'exifEX', 'http://cipa.jp/exif/1.0/')
  const auxiliary = namespace(xmp, 'aux', 'http://ns.adobe.com/exif/1.0/aux/')
  const dc = namespace(xmp, 'dc', 'http://purl.org/dc/elements/1.1/')
  const result = {}
  for (const key of EXPORT_METADATA_FIELDS) {
    const value = own(exif, key) ?? xmlValue(own(tiff, key) ?? own(camera, key))
    if (value !== undefined && value !== null) result[key] = value
  }
  // XMP rights/creator are the explicit descriptive fields; do not infer one from the other.
  const rights = string(xmlValue(dc.rights, true))
  if (rights !== undefined) result.Copyright = rights
  const creators = (Array.isArray(dc.creator) ? dc.creator : [dc.creator])
    .map((value) => string(xmlValue(value)))
    .filter((value) => value !== undefined)
  if (creators.length) result.Artist = creators.length === 1 ? creators[0] : creators
  result.LensModel ??= xmlValue(extra.LensModel ?? auxiliary.Lens)
  result.ISO ??= exif.ISOSpeed ?? xmlValue(camera.ISOSpeedRatings)
  if (result.ISO >= 65535 && exif.ISOSpeed !== undefined) result.ISO = exif.ISOSpeed
  for (const key of ['ExposureTime', 'FNumber', 'FocalLength', 'ISO']) {
    let value = result[key]
    if (typeof value === 'string' && /^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/.test(value)) {
      const [n, d] = value.split('/').map(Number)
      value = d ? n / d : undefined
    }
    if (value !== undefined) result[key] = value
  }
  const exifDate = normalizeCaptureDate(
    exif.DateTimeOriginal,
    exif.OffsetTimeOriginal,
    exif.SubSecTimeOriginal
  )
  const xmpDate = normalizeCaptureDate(xmlValue(camera.DateTimeOriginal))
  const date = xmpDate
    ? normalizeCaptureDate(
        xmpDate.iso,
        xmpDate.exif === exifDate?.exif ? exifDate.offset : undefined,
        xmpDate.exif === exifDate?.exif ? exifDate.subseconds : undefined
      )
    : (exifDate ?? normalizeCaptureDate(result.DateTimeOriginal))
  if (date) result.DateTimeOriginal = date.iso
  else delete result.DateTimeOriginal
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined))
}

async function readBytes(file, start, length) {
  if (![start, length].every(Number.isSafeInteger) || start < 0 || length < 0 || start > file.size - length)
    throw Error('Photo metadata has an invalid container extent')
  const data = new Uint8Array(await file.slice(start, start + length).arrayBuffer())
  if (data.length !== length) throw Error('Photo metadata could not be read completely')
  return data
}
const word = (data, at = 0) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at)
const type = (data, at = 0) => String.fromCharCode(...data.subarray(at, at + 4))

async function boxes(file, start, end) {
  const result = []
  for (let at = start; at < end;) {
    if (end - at < 8) throw Error('Photo metadata has a truncated box header')
    let header = await readBytes(file, at, 8),
      length = word(header),
      bytes = 8
    if (length === 1) {
      const large = await readBytes(file, at + 8, 8)
      const value = new DataView(large.buffer).getBigUint64(0)
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Photo metadata box is too large to address')
      length = Number(value)
      bytes = 16
    } else if (length === 0) length = end - at
    if (length < bytes || length > end - at) throw Error('Photo metadata has an invalid box length')
    result.push({ type: type(header, 4), start: at + bytes, end: at + length, length: length - bytes })
    at += length
  }
  return result
}

function tiffPayload(data) {
  const isTiff = (at) =>
    data.length >= at + 8 &&
    ((data[at] === 73 && data[at + 1] === 73 && data[at + 2] === 42 && data[at + 3] === 0) ||
      (data[at] === 77 && data[at + 1] === 77 && data[at + 2] === 0 && data[at + 3] === 42))
  if (isTiff(0)) return data
  if (type(data) === 'Exif' && data[4] === 0 && data[5] === 0 && isTiff(6)) return data.subarray(6)
  const offset = data.length >= 4 ? word(data) + 4 : -1
  if (offset >= 4 && isTiff(offset)) return data.subarray(offset)
  throw Error('Photo metadata contains an invalid Exif TIFF header')
}

async function jxlMetadata(file) {
  const result = {}
  for (const box of await boxes(file, 0, file.size)) {
    if (box.type === 'Exif') result.exif ??= tiffPayload(await readBytes(file, box.start, box.length))
    if (box.type === 'xml ') result.xmp ??= await readBytes(file, box.start, box.length)
    if (box.type === 'brob' && box.length >= 4) {
      const original = type(await readBytes(file, box.start, 4))
      if (original === 'Exif' || original === 'xml ')
        throw Error('Compressed JPEG XL photo metadata is not supported')
    }
  }
  return result
}

function cursor(data, start = 0) {
  let at = start
  return {
    get offset() {
      return at
    },
    number(bytes) {
      if (bytes > 8 || at > data.length - bytes) throw Error('Photo metadata contains an invalid item table')
      let value = 0
      for (let i = 0; i < bytes; i++) value = value * 256 + data[at++]
      if (!Number.isSafeInteger(value)) throw Error('Photo metadata item offset is too large to address')
      return value
    },
    text() {
      const end = data.indexOf(0, at)
      if (end < 0) throw Error('Photo metadata contains an unterminated item name')
      const value = new TextDecoder().decode(data.subarray(at, end))
      at = end + 1
      return value
    }
  }
}

// Read only item tables and the selected primary image's metadata extents, never its AV1 payload.
async function avifMetadata(file, top) {
  const meta = top.find((box) => box.type === 'meta')
  if (!meta) return {}
  const children = await boxes(file, meta.start + 4, meta.end)
  const one = (name) => children.find((box) => box.type === name)
  const payload = (box) => readBytes(file, box.start, box.length)
  const primaryBox = one('pitm'),
    infoBox = one('iinf'),
    locationBox = one('iloc'),
    referencesBox = one('iref')
  if (!primaryBox || !infoBox || !locationBox || !referencesBox) return {}
  const primaryData = await payload(primaryBox),
    primary = cursor(primaryData, 4).number(primaryData[0] ? 4 : 2)
  const infoData = await readBytes(file, infoBox.start, Math.min(8, infoBox.length))
  const infoStart = infoBox.start + 4 + (infoData[0] ? 4 : 2)
  const items = new Map()
  for (const box of await boxes(file, infoStart, infoBox.end)) {
    if (box.type !== 'infe') continue
    const data = await payload(box),
      version = data[0]
    if (version !== 2 && version !== 3) continue
    const entry = cursor(data, 4),
      id = entry.number(version === 3 ? 4 : 2)
    entry.number(2)
    const kind = type(data, entry.offset)
    entry.number(4)
    entry.text()
    if (kind === 'Exif' || (kind === 'mime' && entry.text() === 'application/rdf+xml')) items.set(id, kind)
  }
  const selected = new Set()
  const referenceHeader = await readBytes(file, referencesBox.start, 4)
  const idBytes = referenceHeader[0] ? 4 : 2
  for (const box of await boxes(file, referencesBox.start + 4, referencesBox.end)) {
    if (box.type !== 'cdsc') continue
    const entry = cursor(await payload(box)),
      from = entry.number(idBytes),
      count = entry.number(2)
    for (let i = 0; i < count; i++)
      if (entry.number(idBytes) === primary && items.has(from)) selected.add(from)
  }
  if (!selected.size) return {}
  const data = await payload(locationBox),
    version = data[0],
    entry = cursor(data, 4)
  if (version > 2) throw Error('This AVIF metadata location version is not supported')
  const sizes = entry.number(1),
    sizes2 = entry.number(1)
  const offsetSize = sizes >> 4,
    lengthSize = sizes & 15,
    baseSize = sizes2 >> 4,
    indexSize = version ? sizes2 & 15 : 0
  const count = entry.number(version < 2 ? 2 : 4),
    located = new Map()
  for (let i = 0; i < count; i++) {
    const id = entry.number(version < 2 ? 2 : 4),
      method = version ? entry.number(2) & 15 : 0
    const reference = entry.number(2),
      base = entry.number(baseSize),
      extents = entry.number(2),
      parts = []
    for (let j = 0; j < extents; j++) {
      if (indexSize) entry.number(indexSize)
      const offset = entry.number(offsetSize),
        length = entry.number(lengthSize)
      if (selected.has(id)) parts.push({ offset: base + offset, length })
    }
    if (selected.has(id)) {
      if (reference || method > 1 || !lengthSize)
        throw Error('This AVIF metadata extent layout is not supported')
      located.set(id, { method, parts })
    }
  }
  const result = {},
    idat = one('idat')
  for (const id of selected) {
    const item = located.get(id)
    if (!item) throw Error('AVIF photo metadata has no item extent')
    if (item.method === 1 && !idat) throw Error('AVIF photo metadata has no item data box')
    const chunks = []
    for (const part of item.parts) {
      if (item.method === 1 && part.offset > idat.length - part.length)
        throw Error('AVIF metadata exceeds its item data')
      chunks.push(await readBytes(file, part.offset + (item.method === 1 ? idat.start : 0), part.length))
    }
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    if (!Number.isSafeInteger(length)) throw Error('AVIF photo metadata is too large to address')
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    if (items.get(id) === 'Exif') result.exif ??= tiffPayload(bytes)
    else result.xmp ??= bytes
  }
  return result
}

export async function metadata(file, { strict = false } = {}) {
  let recognized = false
  try {
    const { parse, sidecar } = await import('./vendor/exifr/exifr.js')
    const options = {
      reviveValues: false,
      translateValues: false,
      pick: tags,
      xmp: false,
      iptc: false,
      silentErrors: !strict
    }
    let exif, xmp
    const blob =
      file instanceof Blob
        ? file
        : file instanceof ArrayBuffer || ArrayBuffer.isView(file)
          ? new Blob([file])
          : null
    const header = blob ? await readBytes(blob, 0, Math.min(16, blob.size)) : new Uint8Array()
    if (header[0] === 255 && header[1] === 10) return {}
    const boxedJxl = type(header, 4) === 'JXL '
    const top = type(header, 4) === 'ftyp' ? await boxes(blob, 0, blob.size) : null
    let avif = false
    if (top) {
      const brands = await readBytes(blob, top[0].start, top[0].length)
      for (let at = 0; at + 4 <= brands.length; at += 4)
        if (at !== 4 && ['avif', 'avis'].includes(type(brands, at))) avif = true
    }
    recognized =
      boxedJxl ||
      avif ||
      (header[0] === 255 && header[1] === 216) ||
      type(header) === '\x89PNG' ||
      (header[0] === 73 && header[1] === 73) ||
      (header[0] === 77 && header[1] === 77)
    if (boxedJxl || avif) {
      const extracted = boxedJxl ? await jxlMetadata(blob) : await avifMetadata(blob, top)
      if (extracted.exif) exif = await parse(extracted.exif, options)
      if (extracted.xmp)
        xmp = await sidecar(extracted.xmp, { reviveValues: false, silentErrors: !strict }, 'xmp')
    } else {
      exif = await parse(file, options)
      const packet = await parse(file, {
        tiff: false,
        xmp: { parse: false },
        iptc: false,
        silentErrors: !strict
      })
      if (packet?.xmp)
        xmp = await sidecar(utf8.encode(packet.xmp), { reviveValues: false, silentErrors: !strict }, 'xmp')
    }
    return normalizedMetadata(exif, xmp)
  } catch (error) {
    if (!recognized && /Unknown file format/.test(error.message)) return {}
    if (strict) throw new Error('Photo metadata could not be read: ' + error.message, { cause: error })
    return {}
  }
}
export function describe(photo) {
  const m = photo.metadata || {}
  const info = [
    photo.name,
    photo.width + ' × ' + photo.height,
    [m.Make, m.Model].filter(Boolean).join(' '),
    m.LensModel
  ]
  const speed = m.ExposureTime,
    exposure = [
      speed ? (speed < 1 ? '1/' + Math.round(1 / speed) : speed) + ' s' : '',
      m.FNumber ? 'ƒ/' + m.FNumber : '',
      m.ISO ? 'ISO ' + m.ISO : '',
      m.FocalLength ? m.FocalLength + ' mm' : ''
    ]
  info.push(
    exposure.filter(Boolean).join(' · '),
    m.DateTimeOriginal ? new Date(m.DateTimeOriginal).toLocaleString() : '',
    Array.isArray(m.Artist) ? m.Artist.join('; ') : m.Artist,
    m.Copyright
  )
  return info.filter(Boolean).join('\n')
}
