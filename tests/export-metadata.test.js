import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, sidecar } from '../web/vendor/exifr/exifr.js'
import {
  EXPORT_METADATA_FIELDS,
  EXPORT_METADATA_POLICIES,
  buildExportMetadata,
  exportMetadataPolicies,
  validateExportMetadataPolicy,
  normalizeCaptureDate
} from '../web/export-metadata.js'
import { encodeColorPng, encodeColorTiff, embedJpegMetadata } from '../web/color-containers.js'
import { makeColorProfile } from '../web/color-spaces.js'
import { metadata, describe } from '../web/metadata.js'

const utf8 = new TextEncoder()
const source = {
  Make: 'OpenLR',
  Model: 'Generated camera',
  LensModel: 'Generated lens',
  DateTimeOriginal: '2024:06:07 08:09:10',
  OffsetTimeOriginal: '+08:00',
  SubSecTimeOriginal: '125',
  ExposureTime: 1 / 125,
  FNumber: 2.8,
  ISO: 200,
  FocalLength: 50,
  Artist: 'Example photographer',
  Copyright: 'Copyright fixture',
  Orientation: 6,
  ImageWidth: 9000,
  ImageHeight: 8000,
  GPSLatitude: 1.25,
  MakerNote: 'private',
  keywords: 'private person',
  Recipe: { Exposure: 3 },
  ICC: 'source profile',
  ColorSpace: 1
}
const options = { policy: 'supported', width: 17, height: 11, colorSpace: 'display-p3' }
const readExif = (bytes) => parse(bytes, { reviveValues: false, translateValues: false })
const text = (bytes) => new TextDecoder().decode(bytes)

test('metadata policies cover exactly rendered formats and preserve an inactive default', () => {
  for (const format of ['image/jpeg', 'image/png', 'image/tiff', 'image/avif', 'image/jxl']) {
    assert.deepEqual(exportMetadataPolicies(format), EXPORT_METADATA_POLICIES)
    assert.equal(validateExportMetadataPolicy(format), 'none')
    for (const policy of EXPORT_METADATA_POLICIES)
      assert.equal(validateExportMetadataPolicy(format, policy), policy)
  }
  for (const format of [
    'original',
    'original-settings',
    'application/rdf+xml',
    'image/x-adobe-dng',
    'video/mp4',
    'image/gif'
  ]) {
    assert.deepEqual(exportMetadataPolicies(format), [])
    assert.equal(validateExportMetadataPolicy(format), 'none')
    assert.throws(() => validateExportMetadataPolicy(format, 'copyright'), /does not support/)
    assert.throws(() => validateExportMetadataPolicy(format, 'supported'), /does not support/)
  }
  for (const policy of [null, '', 'all', {}, 1])
    assert.throws(() => validateExportMetadataPolicy('image/png', policy))
  const unreachable = new Proxy(
    {},
    {
      get() {
        throw Error('inactive metadata must not read its source')
      }
    }
  )
  assert.deepEqual(buildExportMetadata(unreachable), {
    exif: new Uint8Array(),
    xmp: new Uint8Array(),
    tiffTags: { ifd: [], exif: [] }
  })
})

test('supported metadata rebuilds Exif dimensions, direction and color while preserving all ten fields', async () => {
  assert.equal(EXPORT_METADATA_FIELDS.length, 10)
  const before = structuredClone(source),
    payload = buildExportMetadata(source, options)
  assert.deepEqual(source, before)
  const exif = await readExif(payload.exif)
  for (const field of [
    'Make',
    'Model',
    'LensModel',
    'ExposureTime',
    'FNumber',
    'ISO',
    'FocalLength',
    'Artist',
    'Copyright'
  ])
    assert.equal(exif[field], source[field], field)
  assert.equal(exif.DateTimeOriginal, source.DateTimeOriginal)
  assert.equal(exif.OffsetTimeOriginal, '+08:00')
  assert.equal(exif.SubSecTimeOriginal, '125')
  assert.equal(exif.ImageWidth, 17)
  assert.equal(exif.ImageHeight, 11)
  assert.equal(exif.ExifImageWidth, 17)
  assert.equal(exif.ExifImageHeight, 11)
  assert.equal(exif.Orientation, 1)
  assert.equal(exif.ColorSpace, 65535)
  assert.deepEqual([...payload.exif.subarray(0, 4)], [73, 73, 42, 0])
  const packet = text(payload.xmp)
  assert.match(packet, /2024-06-07T08:09:10\.125\+08:00/)
  for (const forbidden of ['GPS', 'MakerNote', 'private', 'Recipe', 'source profile', 'crs:', 'olr:']) {
    assert.ok(!packet.includes(forbidden), forbidden)
    assert.ok(!text(payload.exif).includes(forbidden), forbidden)
  }
})

test('copyright only reads rights and never includes creator or capture data', async () => {
  const input = { Copyright: 'Fixture rights' }
  for (const field of EXPORT_METADATA_FIELDS.filter((field) => field !== 'Copyright'))
    Object.defineProperty(input, field, {
      get() {
        throw Error('copyright policy read ' + field)
      }
    })
  const payload = buildExportMetadata(input, { ...options, policy: 'copyright' })
  const exif = await readExif(payload.exif)
  assert.equal(exif.Copyright, 'Fixture rights')
  assert.equal(exif.Artist, undefined)
  assert.equal(exif.Make, undefined)
  assert.equal(exif.DateTimeOriginal, undefined)
  assert.ok(!text(payload.xmp).includes('dc:creator'))
  assert.ok(!text(payload.xmp).includes('DateTimeOriginal'))
  const absent = buildExportMetadata(
    { Artist: 'Not a copyright notice' },
    { ...options, policy: 'copyright' }
  )
  assert.ok(!text(absent.xmp).includes('dc:rights'))
})

test('ordered multiple creators survive XMP, PNG and TIFF without replacing the list by its first author', async () => {
  const frame = { width: 17, height: 11, data: new Uint8Array(17 * 11 * 4).fill(127) }
  for (const creators of [
    ['First photographer', 'Second; photographer'],
    ['创作者甲', 'Example & <author> 📷', '创作者乙']
  ]) {
    const input = { ...source, Artist: ['', ...creators, '  '] }
    const original = structuredClone(input)
    const payload = buildExportMetadata(input, options)
    assert.deepEqual(input, original)
    const xmp = await sidecar(payload.xmp, { reviveValues: false }, 'xmp')
    assert.deepEqual(
      xmp.dc.creator,
      creators.map((value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'))
    )
    const exif = await readExif(payload.exif)
    assert.equal(
      exif.Artist,
      creators.every((value) => /^[\x20-\x7e]*$/.test(value)) ? creators.join('; ') : undefined
    )
    for (const bytes of [
      encodeColorPng(frame, makeColorProfile('display-p3'), payload),
      encodeColorTiff(frame, makeColorProfile('display-p3'), payload)
    ]) {
      const result = await metadata(bytes, { strict: true })
      assert.deepEqual(result.Artist, creators)
      assert.match(
        describe({ name: 'Generated', width: 17, height: 11, metadata: result }),
        new RegExp(creators.join('; ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      )
    }
    const copyright = buildExportMetadata(input, { ...options, policy: 'copyright' })
    assert.equal((await readExif(copyright.exif)).Artist, undefined)
    assert.equal((await sidecar(copyright.xmp, {}, 'xmp')).dc.creator, undefined)
  }
  const single = buildExportMetadata({ Artist: ['', 'Only author'] }, options)
  const bytes = encodeColorPng(frame, makeColorProfile('display-p3'), single)
  assert.equal((await metadata(bytes, { strict: true })).Artist, 'Only author')
})

test('Unicode stays lossless in standard XMP rather than masquerading as ASCII Exif', async () => {
  const input = {
    ...source,
    Copyright: '© 示例 & <rights> 📷 é &amp;',
    Artist: '创作者 Example',
    Make: '示例相机',
    Model: '型号 📷',
    LensModel: '镜头'
  }
  const payload = buildExportMetadata(input, options),
    exif = await readExif(payload.exif)
  for (const key of ['Copyright', 'Artist', 'Make', 'Model', 'LensModel']) assert.equal(exif[key], undefined)
  const raw = text(payload.xmp)
  assert.match(raw, /© 示例 &amp; &lt;rights&gt; 📷 é &amp;amp;/)
  const parsed = await sidecar(payload.xmp, { reviveValues: false }, 'xmp')
  assert.equal(parsed.dc.rights.lang, 'x-default')
  assert.equal(parsed.dc.creator, '创作者 Example')
  const frame = { width: 17, height: 11, data: new Uint8Array(17 * 11 * 4).fill(127) }
  for (const bytes of [
    encodeColorPng(frame, makeColorProfile('display-p3'), payload),
    encodeColorTiff(frame, makeColorProfile('display-p3'), payload),
    embedJpegMetadata(Uint8Array.of(255, 216, 255, 217), payload)
  ]) {
    const readback = await metadata(bytes, { strict: true })
    assert.equal(readback.Copyright, input.Copyright)
    assert.equal(readback.Artist, input.Artist)
    assert.equal(readback.Make, input.Make)
    assert.equal(readback.Model, input.Model)
    assert.equal(readback.LensModel, input.LensModel)
  }
  for (const invalid of ['NUL\0notice', 'Control\x01text', 'Lone\ud800surrogate'])
    assert.throws(() => buildExportMetadata({ Copyright: invalid }, options), /cannot be represented in XML/)
})

test('capture dates retain unknown timezone and actual offset/subseconds without inventing an instant', async () => {
  assert.deepEqual(normalizeCaptureDate('2024:02:29 10:11:12'), {
    iso: '2024-02-29T10:11:12',
    exif: '2024:02:29 10:11:12'
  })
  assert.equal(
    normalizeCaptureDate('2024:06:07 08:09:10', '-03:30', '0005').iso,
    '2024-06-07T08:09:10.0005-03:30'
  )
  assert.equal(normalizeCaptureDate('2024-06-07T08:09:10.125Z').offset, '+00:00')
  for (const value of ['2023:02:29 01:02:03', '2024:02:30 01:02:03', '2024:13:01 00:00:00', 'invalid'])
    assert.equal(normalizeCaptureDate(value), undefined)
  const payload = buildExportMetadata({ DateTimeOriginal: '2024:06:07 08:09:10' }, options)
  const exif = await readExif(payload.exif)
  assert.equal(exif.OffsetTimeOriginal, undefined)
  assert.equal(exif.SubSecTimeOriginal, undefined)
  assert.match(text(payload.xmp), /<exif:DateTimeOriginal>2024-06-07T08:09:10<\//)
})

test('XMP-only photo fields and explicit capture offsets survive without an Exif mirror', async () => {
  const input = {
    ...source,
    Copyright: '  © 保留空格  ',
    Artist: '  Creator  ',
    ISO: '200',
    ExposureTime: '1/125',
    FNumber: '2.8',
    FocalLength: '50',
    DateTimeOriginal: '2024-06-07T08:09:10.125Z'
  }
  const packet = buildExportMetadata(input, options)
  assert.match(text(packet.xmp), />  © 保留空格  <\/rdf:li>/)
  assert.match(text(packet.xmp), />  Creator  <\/rdf:li>/)
  const frame = { width: 17, height: 11, data: new Uint8Array(17 * 11 * 4) }
  const bytes = encodeColorPng(frame, makeColorProfile('display-p3'), { xmp: packet.xmp })
  const result = await metadata(bytes, { strict: true })
  assert.equal(result.ISO, 200)
  assert.equal(result.ExposureTime, 1 / 125)
  assert.equal(result.FNumber, 2.8)
  assert.equal(result.FocalLength, 50)
  assert.equal(result.DateTimeOriginal, '2024-06-07T08:09:10.125Z')
  assert.equal(result.LensModel, source.LensModel)
  // A complete XMP timestamp overrides the stale physical Exif timezone.
  const both = encodeColorPng(frame, makeColorProfile('display-p3'), {
    ...buildExportMetadata(source, options),
    xmp: packet.xmp
  })
  assert.equal((await metadata(both, { strict: true })).DateTimeOriginal, '2024-06-07T08:09:10.125Z')
})

test('independent ExifTool fixture preserves Unicode XMP precedence and raw capture time on input', async () => {
  const result = await metadata(await readFile(new URL('./fixtures/export-metadata.png', import.meta.url)), {
    strict: true
  })
  assert.deepEqual(result, {
    Make: 'OpenLR Fixture',
    Model: 'Generated Camera',
    LensModel: 'Generated 50mm',
    DateTimeOriginal: '2024-06-07T08:09:10.125+08:00',
    ExposureTime: 1 / 125,
    FNumber: 2.8,
    ISO: 200,
    FocalLength: 50,
    Artist: '创作者 Example',
    Copyright: '© 示例 & <rights> 📷 é'
  })
  const bad = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0)
  assert.deepEqual(await metadata(bad), {})
  await assert.rejects(metadata(bad, { strict: true }), /metadata could not be read/)
  assert.deepEqual(
    await metadata(utf8.encode('A source format without a supported metadata reader'), { strict: true }),
    {}
  )
})

test('metadata validates output coordinates and high ISO without clamping a source value to a sentinel', async () => {
  for (const changes of [{ width: 0 }, { height: Infinity }, { width: 1.5 }, { colorSpace: 'unknown' }])
    assert.throws(() => buildExportMetadata(source, { ...options, ...changes }))
  const payload = buildExportMetadata({ ISO: 100000, ExposureTime: 1 / 8000, FNumber: 1.4 }, options)
  const parsed = await readExif(payload.exif)
  assert.equal(parsed.ISO, 65535)
  assert.equal(parsed.ISOSpeed, 100000)
  assert.equal(parsed.ExposureTime, 1 / 8000)
  const frame = { width: 17, height: 11, data: new Uint8Array(17 * 11 * 4) }
  const bytes = encodeColorPng(frame, makeColorProfile('srgb'), payload)
  assert.equal((await metadata(bytes, { strict: true })).ISO, 100000)
})

function concatenate(parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}
function be(value, bytes = 4) {
  return Uint8Array.from(
    { length: bytes },
    (_, index) => Math.floor(value / 256 ** (bytes - index - 1)) & 255
  )
}
const box = (name, data) => concatenate([be(data.length + 8), utf8.encode(name), data])
const full = (version = 0) => Uint8Array.of(version, 0, 0, 0)

test('JPEG XL metadata skips codestream bytes and respects the Exif header offset', async () => {
  const payload = buildExportMetadata(source, options)
  const bytes = concatenate([
    box('JXL ', Uint8Array.of(13, 10, 135, 10)),
    box('jxlc', new Uint8Array(1024 * 1024)),
    box('Exif', concatenate([be(6), utf8.encode('Exif\0\0'), payload.exif])),
    box('xml ', payload.xmp)
  ])
  let reads = 0
  class ObservedBlob extends Blob {
    slice(start, end) {
      reads += end - start
      return super.slice(start, end)
    }
  }
  const result = await metadata(new ObservedBlob([bytes]), { strict: true })
  assert.equal(result.Copyright, source.Copyright)
  assert.equal(result.ExposureTime, source.ExposureTime)
  assert.ok(reads < 10000, 'metadata access must skip the image codestream extent')
  const compressed = concatenate([
    box('JXL ', Uint8Array.of(13, 10, 135, 10)),
    box('brob', utf8.encode('xml unsupported'))
  ])
  await assert.rejects(metadata(compressed, { strict: true }), /Compressed JPEG XL/)
  assert.deepEqual(await metadata(compressed), {})
  assert.deepEqual(await metadata(Uint8Array.of(255, 10, 0, 0), { strict: true }), {})
})

test('AVIF metadata follows primary-image associations and reads only declared item extents', async () => {
  // Generated BMFF tables test metadata addressing only; no AV1 image decoding is claimed.
  const payload = buildExportMetadata(source, options)
  const foreign = buildExportMetadata({ Copyright: 'Unrelated image rights' }, options)
  const ftyp = box('ftyp', concatenate([utf8.encode('avif'), be(0), utf8.encode('avifmif1')]))
  const infe = (id, name, mime) =>
    box(
      'infe',
      concatenate([
        full(2),
        be(id, 2),
        be(0, 2),
        utf8.encode(name),
        Uint8Array.of(0),
        ...(mime ? [utf8.encode('application/rdf+xml\0')] : [])
      ])
    )
  const iinf = box(
    'iinf',
    concatenate([full(), be(3, 2), infe(2, 'Exif'), infe(3, 'mime', true), infe(4, 'mime', true)])
  )
  const iref = box(
    'iref',
    concatenate([
      full(),
      ...[
        [2, 1],
        [3, 1],
        [4, 9]
      ].map(([from, to]) => box('cdsc', concatenate([be(from, 2), be(1, 2), be(to, 2)])))
    ])
  )
  const contents = [concatenate([be(0), payload.exif]), payload.xmp, foreign.xmp]
  const makeMeta = (start) => {
    let offset = start
    const entries = contents.map((data, index) => {
      const entry = concatenate([be(index + 2, 2), be(0, 2), be(1, 2), be(offset), be(data.length)])
      offset += data.length
      return entry
    })
    return box(
      'meta',
      concatenate([
        full(),
        box('pitm', concatenate([full(), be(1, 2)])),
        iinf,
        iref,
        box('iloc', concatenate([full(), Uint8Array.of(0x44, 0), be(3, 2), ...entries]))
      ])
    )
  }
  const meta = makeMeta(ftyp.length + makeMeta(0).length + 8)
  const bytes = concatenate([ftyp, meta, box('mdat', concatenate(contents))])
  const result = await metadata(bytes, { strict: true })
  assert.equal(result.Copyright, source.Copyright)
  assert.equal(result.Artist, source.Artist)
  assert.equal(result.DateTimeOriginal, '2024-06-07T08:09:10.125+08:00')
  for (const major of ['mif1', 'mif2']) {
    const compatible = bytes.slice()
    compatible.set(utf8.encode(major), 8)
    assert.equal((await metadata(compatible, { strict: true })).Copyright, source.Copyright)
  }
})
