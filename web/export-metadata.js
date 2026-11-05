import { COLOR_SPACES } from './color-spaces.js'
import { RENDERED_PHOTO_TYPES } from './formats.js'
import { encodeExifTiff } from './color-containers.js'
import { assertXmlText, escapeXml } from './xml.js'

export const EXPORT_METADATA_POLICIES = ['none', 'copyright', 'supported']
export const EXPORT_METADATA_MESSAGES = {
  label: 'Metadata',
  policies: { none: 'None', copyright: 'Copyright only', supported: 'Copyright & photo info' },
  unsupported: 'This format does not support photo metadata export'
}
export const EXPORT_METADATA_FIELDS = [
  'Make',
  'Model',
  'LensModel',
  'DateTimeOriginal',
  'ExposureTime',
  'FNumber',
  'ISO',
  'FocalLength',
  'Artist',
  'Copyright'
]
const encoder = new TextEncoder()

export function exportMetadataPolicies(format) {
  return RENDERED_PHOTO_TYPES.includes(format) ? [...EXPORT_METADATA_POLICIES] : []
}

export function validateExportMetadataPolicy(format, policy = 'none') {
  if (!EXPORT_METADATA_POLICIES.includes(policy)) throw Error('Choose a supported metadata policy')
  if (policy !== 'none' && !RENDERED_PHOTO_TYPES.includes(format))
    throw Error(EXPORT_METADATA_MESSAGES.unsupported)
  return policy
}

// Read the wall-clock components without converting an unknown timezone into UTC.
export function normalizeCaptureDate(value, offset, subseconds) {
  if (value instanceof Date) value = Number.isFinite(+value) ? value.toISOString() : ''
  if (typeof value !== 'string') return undefined
  const match =
    /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(
      value.trim()
    )
  if (!match) return undefined
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (!month || month > 12 || !day || day > days[month - 1] || hour > 23 || minute > 59 || second > 59)
    return undefined
  const fraction = match[7] ?? (/^\d+$/.test(String(subseconds ?? '')) ? String(subseconds) : '')
  const zone = match[8] ?? (typeof offset === 'string' ? offset.trim() : '')
  if (zone && zone !== 'Z' && !/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(zone)) return undefined
  const date = `${match[1]}-${match[2]}-${match[3]}`
  const time = `${match[4]}:${match[5]}:${match[6]}`
  return {
    iso: `${date}T${time}${fraction ? '.' + fraction : ''}${zone}`,
    exif: `${match[1]}:${match[2]}:${match[3]} ${time}`,
    ...(zone ? { offset: zone === 'Z' ? '+00:00' : zone } : {}),
    ...(fraction ? { subseconds: fraction } : {})
  }
}

function text(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return assertXmlText(value)
}

function numeric(value, integer = false) {
  if (typeof value === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
    value = Number(value)
  if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite))
    value = value[1] ? value[0] / value[1] : NaN
  if (typeof value === 'string' && /^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/.test(value)) {
    const [numerator, denominator] = value.split('/').map(Number)
    value = denominator ? numerator / denominator : NaN
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 0xffffffff ||
    (integer && !Number.isInteger(value))
  )
    return undefined
  return value
}

// Continued fractions retain common shutter/aperture values within TIFF's uint32 pairs.
function rational(value) {
  let remainder = value,
    p0 = 0,
    p1 = 1,
    q0 = 1,
    q1 = 0
  for (let step = 0; step < 64; step++) {
    const whole = Math.floor(remainder),
      p = whole * p1 + p0,
      q = whole * q1 + q0
    if (!Number.isSafeInteger(p) || !Number.isSafeInteger(q) || p > 0xffffffff || q > 0xffffffff) break
    p0 = p1
    p1 = p
    q0 = q1
    q1 = q
    if (Math.abs(p / q - value) <= Math.max(Number.EPSILON, Math.abs(value) * 1e-12)) break
    const fraction = remainder - whole
    if (!fraction) break
    remainder = 1 / fraction
  }
  if (!p1 || !q1) throw Error('Photo metadata cannot be represented as an Exif rational')
  return [p1, q1]
}

function selectedFields(source, policy) {
  const fields = {}
  const copyright = text(source?.Copyright ?? source?.rights)
  if (copyright !== undefined) fields.Copyright = copyright
  if (policy !== 'supported') return fields
  for (const key of ['Make', 'Model', 'LensModel']) {
    const value = text(source?.[key])
    if (value !== undefined) fields[key] = value
  }
  const creators = (Array.isArray(source?.Artist) ? source.Artist : [source?.Artist])
    .map(text)
    .filter((value) => value !== undefined)
  if (creators.length) fields.Artist = creators.length === 1 ? creators[0] : creators
  for (const key of ['ExposureTime', 'FNumber', 'ISO', 'FocalLength']) {
    const value = numeric(source?.[key], key === 'ISO')
    if (value !== undefined) fields[key] = value
  }
  const date = normalizeCaptureDate(
    source?.DateTimeOriginal,
    source?.OffsetTimeOriginal,
    source?.SubSecTimeOriginal
  )
  if (date) fields.DateTimeOriginal = date.iso
  return fields
}

function metadataXmp(fields, width, height, colorSpace) {
  const properties = []
  const property = (name, value) => properties.push(`<${name}>${escapeXml(value)}</${name}>`)
  property('tiff:ImageWidth', width)
  property('tiff:ImageLength', height)
  property('tiff:Orientation', 1)
  property('exif:PixelXDimension', width)
  property('exif:PixelYDimension', height)
  property('exif:ColorSpace', colorSpace === 'srgb' ? 1 : 65535)
  if (fields.Copyright !== undefined)
    properties.push(
      '<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">' +
        escapeXml(fields.Copyright) +
        '</rdf:li></rdf:Alt></dc:rights>'
    )
  if (fields.Artist !== undefined)
    properties.push(
      '<dc:creator><rdf:Seq>' +
        (Array.isArray(fields.Artist) ? fields.Artist : [fields.Artist])
          .map((creator) => '<rdf:li>' + escapeXml(creator) + '</rdf:li>')
          .join('') +
        '</rdf:Seq></dc:creator>'
    )
  for (const key of ['Make', 'Model']) if (fields[key] !== undefined) property('tiff:' + key, fields[key])
  if (fields.LensModel !== undefined) property('aux:Lens', fields.LensModel)
  if (fields.DateTimeOriginal !== undefined) property('exif:DateTimeOriginal', fields.DateTimeOriginal)
  for (const key of ['ExposureTime', 'FNumber', 'FocalLength'])
    if (fields[key] !== undefined) property('exif:' + key, rational(fields[key]).join('/'))
  if (fields.ISO !== undefined)
    properties.push(
      '<exif:ISOSpeedRatings><rdf:Seq><rdf:li>' + fields.ISO + '</rdf:li></rdf:Seq></exif:ISOSpeedRatings>'
    )
  return encoder.encode(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" ' +
      'xmlns:aux="http://ns.adobe.com/exif/1.0/aux/">' +
      properties.join('') +
      '</rdf:Description></rdf:RDF></x:xmpmeta>'
  )
}

export function buildExportMetadata(source, { policy = 'none', width, height, colorSpace = 'srgb' } = {}) {
  if (!EXPORT_METADATA_POLICIES.includes(policy)) throw Error('Choose a supported metadata policy')
  if (policy === 'none')
    return { exif: new Uint8Array(), xmp: new Uint8Array(), tiffTags: { ifd: [], exif: [] } }
  if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff))
    throw Error('Photo metadata requires the actual output dimensions')
  if (!Object.hasOwn(COLOR_SPACES, colorSpace)) throw Error('Choose a supported output color space')
  const fields = selectedFields(source, policy)
  const tiffTags = { ifd: [], exif: [] }
  const add = (group, id, type, values) => tiffTags[group].push({ id, type, values })
  add('ifd', 256, 4, [width])
  add('ifd', 257, 4, [height])
  add('ifd', 274, 3, [1])
  add('exif', 40962, 4, [width])
  add('exif', 40963, 4, [height])
  add('exif', 40961, 3, [colorSpace === 'srgb' ? 1 : 65535])
  for (const [key, id] of [
    ['Make', 271],
    ['Model', 272],
    ['Copyright', 33432]
  ])
    if (fields[key] !== undefined && /^[\x20-\x7e]*$/.test(fields[key])) add('ifd', id, 2, fields[key])
  const artist = Array.isArray(fields.Artist) ? fields.Artist.join('; ') : fields.Artist
  if (artist !== undefined && /^[\x20-\x7e]*$/.test(artist)) add('ifd', 315, 2, artist)
  if (fields.LensModel !== undefined && /^[\x20-\x7e]*$/.test(fields.LensModel))
    add('exif', 42036, 2, fields.LensModel)
  const date = normalizeCaptureDate(fields.DateTimeOriginal)
  if (date) {
    add('exif', 36867, 2, date.exif)
    if (date.offset) add('exif', 36881, 2, date.offset)
    if (date.subseconds) add('exif', 37521, 2, date.subseconds)
  }
  for (const [key, id] of [
    ['ExposureTime', 33434],
    ['FNumber', 33437],
    ['FocalLength', 37386]
  ])
    if (fields[key] !== undefined) add('exif', id, 5, [rational(fields[key])])
  if (fields.ISO !== undefined) {
    add('exif', 34855, 3, [Math.min(fields.ISO, 65535)])
    if (fields.ISO >= 65535) {
      add('exif', 34864, 3, [3])
      add('exif', 34867, 4, [fields.ISO])
    }
  }
  return { exif: encodeExifTiff(tiffTags), xmp: metadataXmp(fields, width, height, colorSpace), tiffTags }
}
