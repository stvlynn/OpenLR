import test from 'node:test'
import assert from 'node:assert/strict'
import exifr from 'exifr'
import { inflateSync } from 'node:zlib'
import { chromium } from 'playwright-core'
import {
  encodeExifTiff,
  encodeColorTiff,
  encodeColorPng,
  embedJpegProfile,
  embedJpegMetadata,
  embedPngMetadata
} from '../web/color-containers.js'
import { makeColorProfile } from '../web/color-spaces.js'
import { pngChunk, pngChunks, PNG_SIGNATURE } from '../web/png-container.js'
import UTIF from '../web/vendor/codecs/utif.js'
import { serveWorkspace } from './browser-server.mjs'

const text = new TextEncoder(),
  profile = makeColorProfile('display-p3'),
  tiffTags = {
    ifd: [
      { id: 256, type: 4, values: [17] },
      { id: 257, type: 4, values: [513] },
      { id: 271, type: 2, values: 'OpenLR Fixture Camera' },
      { id: 272, type: 2, values: 'Generated Model' },
      { id: 274, type: 3, values: [1] },
      { id: 315, type: 2, values: 'Generated Artist' },
      { id: 33432, type: 2, values: 'Copyright 2026 OpenLR fixture' }
    ],
    exif: [
      { id: 33434, type: 5, values: [[1, 125]] },
      { id: 33437, type: 5, values: [[28, 10]] },
      { id: 34855, type: 3, values: [200] },
      { id: 36864, type: 7, values: text.encode('0232') },
      { id: 36867, type: 2, values: '2026:11:05 12:34:56' },
      { id: 36881, type: 2, values: '+08:00' },
      { id: 37386, type: 5, values: [[50, 1]] },
      { id: 37521, type: 2, values: '123' },
      { id: 40961, type: 3, values: [65535] },
      { id: 40962, type: 4, values: [17] },
      { id: 40963, type: 4, values: [513] },
      { id: 42036, type: 2, values: 'Generated 50 mm' }
    ]
  },
  xmp = text.encode(`<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">版权所有 © 测试摄影师 &amp; OpenLR</rdf:li></rdf:Alt></dc:rights>
<dc:creator><rdf:Seq><rdf:li>测试摄影师</rdf:li></rdf:Seq></dc:creator>
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`),
  metadata = { exif: encodeExifTiff(tiffTags), xmp, tiffTags },
  options = { xmp: true, translateValues: false, reviveValues: false, mergeOutput: false }

function frame(depth = 8) {
  const Type = depth === 16 ? Uint16Array : Uint8Array
  return {
    width: 17,
    height: 513,
    data: Type.from({ length: 17 * 513 * 4 }, (_, index) =>
      index % 4 === 3 ? (depth === 16 ? 65535 : 255) : (index * 37) % (depth === 16 ? 65536 : 256)
    )
  }
}

function assertExif(parsed) {
  assert.equal(parsed.ifd0.Copyright, 'Copyright 2026 OpenLR fixture')
  assert.equal(parsed.ifd0.Artist, 'Generated Artist')
  assert.equal(parsed.ifd0.Make, 'OpenLR Fixture Camera')
  assert.equal(parsed.ifd0.Orientation, 1)
  assert.equal(parsed.exif.ExposureTime, 1 / 125)
  assert.equal(parsed.exif.FNumber, 2.8)
  assert.equal(parsed.exif.ISO, 200)
  assert.equal(parsed.exif.DateTimeOriginal, '2026:11:05 12:34:56')
  assert.equal(parsed.exif.OffsetTimeOriginal, '+08:00')
  assert.equal(parsed.exif.SubSecTimeOriginal, '123')
  assert.equal(parsed.exif.FocalLength, 50)
  assert.equal(parsed.exif.LensModel, 'Generated 50 mm')
  assert.equal(parsed.exif.ExifImageWidth, 17)
  assert.equal(parsed.exif.ExifImageHeight, 513)
  assert.equal(parsed.exif.ColorSpace, 65535)
  assert.equal(parsed.gps, undefined)
}

function marker(id, payload) {
  return Buffer.concat([
    Buffer.from([255, id, (payload.length + 2) >>> 8, (payload.length + 2) & 255]),
    Buffer.from(payload)
  ])
}

function jpegFixture() {
  const jfif = marker(224, text.encode('JFIF\0')),
    adobe = marker(238, text.encode('Adobe\0\0\0\0\0\x01')),
    unrelated = marker(226, text.encode('keep application data')),
    scan = Buffer.from([255, 218, 0, 2, 1, 255, 0, 2, 255, 208, 3, 255, 217])
  return {
    bytes: Buffer.concat([Buffer.from([255, 216]), jfif, adobe, unrelated, scan]),
    jfif,
    adobe,
    unrelated,
    scan
  }
}

test('one TIFF serializer produces independently readable Exif directories and exact 8/16-bit raster samples', async () => {
  assertExif(await exifr.parse(metadata.exif, options))
  const largeProfile = new Uint8Array(170003)
  largeProfile.set(profile)
  for (const depth of [8, 16]) {
    const pixels = frame(depth),
      source = pixels.data.slice(),
      encoded = encodeColorTiff(pixels, largeProfile, metadata),
      ifd = UTIF.decode(encoded.buffer)[0]
    const parsed = await exifr.parse(encoded, options)
    assertExif(parsed)
    assert.equal(parsed.dc.creator, '测试摄影师')
    assert.deepEqual(ifd.t256, [17])
    assert.deepEqual(ifd.t257, [513])
    assert.deepEqual(ifd.t274, [1])
    assert.deepEqual(ifd.t258, Array(4).fill(depth))
    assert.deepEqual(Buffer.from(ifd.t34675), Buffer.from(largeProfile))
    assert.deepEqual(Buffer.from(ifd.t700), Buffer.from(xmp))
    UTIF.decodeImage(encoded.buffer, ifd)
    if (depth === 8) assert.deepEqual(ifd.data, source)
    else {
      const view = new DataView(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength)
      assert.deepEqual(
        Uint16Array.from({ length: source.length }, (_, i) => view.getUint16(i * 2, true)),
        source
      )
      assert.ok(source.some((value) => value % 257 !== 0))
    }
    assert.deepEqual(pixels.data, source)
    const view = new DataView(encoded.buffer),
      root = view.getUint32(4, true),
      count = view.getUint16(root, true),
      ids = Array.from({ length: count }, (_, i) => view.getUint16(root + 2 + i * 12, true))
    assert.deepEqual(
      ids,
      ids.toSorted((a, b) => a - b)
    )
    const at = root + 2 + ids.indexOf(34665) * 12
    assert.equal(view.getUint16(at + 2, true), 4)
    assert.equal(view.getUint32(at + 4, true), 1)
    assert.equal(view.getUint32(at + 8, true) % 2, 0)
  }
})

test('JPEG shares one marker walker, keeps ICC/JFIF/Adobe/entropy, and fails at the actual APP1 capacity', async () => {
  const original = jpegFixture(),
    tagged = embedJpegProfile(original.bytes, profile, metadata),
    replaced = embedJpegMetadata(tagged, metadata)
  const parsed = await exifr.parse(tagged, options)
  assertExif(parsed)
  assert.equal(parsed.dc.creator, '测试摄影师')
  assertExif(await exifr.parse(replaced, options))
  for (const bytes of [tagged, replaced]) {
    assert.deepEqual(Buffer.from(bytes.subarray(2, 2 + original.jfif.length)), original.jfif)
    assert.ok(Buffer.from(bytes).includes(original.adobe))
    assert.ok(Buffer.from(bytes).includes(original.unrelated))
    assert.deepEqual(Buffer.from(bytes.subarray(-original.scan.length)), original.scan)
    assert.ok(Buffer.from(bytes).includes(Buffer.from(profile)))
    assert.ok(Buffer.from(bytes).includes(Buffer.from(xmp)))
  }
  assert.deepEqual(replaced, tagged)
  assert.throws(
    () => embedJpegMetadata(original.bytes, { exif: new Uint8Array(65528) }),
    /classic TIFF header/
  )
  const exifLimit = new Uint8Array(65527)
  exifLimit.set(metadata.exif)
  assert.doesNotThrow(() => embedJpegMetadata(original.bytes, { exif: exifLimit }))
  const tooLarge = new Uint8Array(65528)
  tooLarge.set(metadata.exif)
  assert.throws(() => embedJpegMetadata(original.bytes, { exif: tooLarge }), /APP1 segment length/)
  const xmpLimit = 65533 - text.encode('http://ns.adobe.com/xap/1.0/\0').length
  assert.doesNotThrow(() => embedJpegMetadata(original.bytes, { xmp: new Uint8Array(xmpLimit) }))
  assert.throws(
    () => embedJpegMetadata(original.bytes, { xmp: new Uint8Array(xmpLimit + 1) }),
    /APP1 segment length/
  )
})

test('PNG writes pre-IDAT eXIf and UTF-8 iTXt with valid CRC, preserving existing compressed image/profile bytes', async () => {
  const pixels = frame(),
    plain = encodeColorPng(pixels, profile),
    tagged = embedPngMetadata(plain, metadata),
    direct = encodeColorPng(pixels, profile, metadata),
    chunks = [...pngChunks(tagged)],
    plainChunks = [...pngChunks(plain)]
  assert.deepEqual(tagged, direct)
  assertExif(await exifr.parse(tagged, options))
  assert.deepEqual(
    chunks.map(({ type }) => type),
    ['IHDR', 'iCCP', 'eXIf', 'iTXt', 'IDAT', 'IEND']
  )
  for (const type of ['IHDR', 'iCCP', 'IDAT'])
    assert.deepEqual(
      chunks.filter((chunk) => chunk.type === type),
      plainChunks.filter((chunk) => chunk.type === type)
    )
  const xmpChunk = chunks.find(({ type }) => type === 'iTXt').data,
    prefix = text.encode('XML:com.adobe.xmp\0')
  assert.deepEqual(xmpChunk.subarray(0, prefix.length), prefix)
  assert.deepEqual(xmpChunk.subarray(prefix.length, prefix.length + 4), Uint8Array.of(0, 0, 0, 0))
  assert.deepEqual(xmpChunk.subarray(prefix.length + 4), xmp)
  const image = inflateSync(chunks.find(({ type }) => type === 'IDAT').data)
  assert.equal(image.length, (pixels.width * 4 + 1) * pixels.height)
  assert.deepEqual(embedPngMetadata(tagged, metadata), tagged)
  const stale = Buffer.concat([
      PNG_SIGNATURE,
      ...plainChunks.slice(0, 2).map(({ type, data }) => pngChunk(type, data)),
      pngChunk('eXIf', metadata.exif),
      pngChunk('tEXt', text.encode('XML:com.adobe.xmp\0stale')),
      pngChunk('tEXt', text.encode('Comment\0retained')),
      ...plainChunks.slice(2).map(({ type, data }) => pngChunk(type, data))
    ]),
    replaced = [...pngChunks(embedPngMetadata(stale, metadata))]
  assert.equal(replaced.filter(({ type }) => type === 'eXIf').length, 1)
  assert.equal(replaced.filter(({ type }) => type === 'iTXt').length, 1)
  assert.deepEqual(replaced.find(({ type }) => type === 'tEXt').data, text.encode('Comment\0retained'))
  const damaged = tagged.slice()
  damaged[damaged.length - 1] ^= 1
  assert.throws(() => embedPngMetadata(damaged, metadata), /CRC/)
  assert.throws(() => embedPngMetadata(tagged.subarray(0, -12), metadata), /Incomplete PNG/)
})

test('TIFF metadata rejects structural conflicts and invalid field encodings without changing source pixels', () => {
  assert.throws(() => encodeExifTiff({ ifd: [{ id: 315, type: 2, values: '中文' }] }), /ASCII/)
  assert.throws(
    () => encodeExifTiff({ exif: [{ id: 33434, type: 5, values: [[1, 0]] }] }),
    /nonzero denominator/
  )
  assert.throws(() => encodeExifTiff({ ifd: [{ id: 274, type: 3, values: [65536] }] }), /field range/)
  assert.throws(() => encodeExifTiff({ ifd: [tiffTags.ifd[0], tiffTags.ifd[0]] }), /Duplicate/)
  for (const tag of [
    { id: 274, type: 3, values: [6] },
    { id: 256, type: 4, values: [999] },
    { id: 34675, type: 7, values: new Uint8Array([1]) }
  ])
    assert.throws(
      () => encodeColorTiff(frame(), profile, { tiffTags: { ifd: [tag] } }),
      /rendered TIFF|raster tag/
    )
  assert.throws(() => encodeColorTiff(frame(), profile, { exif: metadata.exif }), /structured TIFF tags/)
  assert.throws(
    () => encodeColorTiff(frame(), profile, { tiffTags: { exif: [{ id: 40962, type: 4, values: [999] }] } }),
    /Exif dimensions must match/
  )
  assert.deepEqual(
    encodeColorPng(frame(), profile, { exif: new Uint8Array(), xmp: new Uint8Array() }),
    encodeColorPng(frame(), profile)
  )
  assert.deepEqual(
    encodeColorTiff(frame(), profile, {
      exif: new Uint8Array(),
      xmp: new Uint8Array(),
      tiffTags: { ifd: [], exif: [] }
    }),
    encodeColorTiff(frame(), profile)
  )
})

test('Chrome JPEG metadata wrapping preserves actual decoded pixels and independently reads Unicode XMP', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(
    async (payload) => {
      const { embedJpegProfile, embedJpegMetadata } = await import('./color-containers.js'),
        { makeColorProfile } = await import('./color-spaces.js'),
        { parse } = await import('./vendor/exifr/exifr.js'),
        canvas = document.createElement('canvas')
      canvas.width = 17
      canvas.height = 513
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#698bad'
      ctx.fillRect(0, 0, 17, 513)
      const original = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9)),
        metadata = { exif: new Uint8Array(payload.exif), xmp: new Uint8Array(payload.xmp) },
        baseline = embedJpegProfile(await original.arrayBuffer(), makeColorProfile('display-p3')),
        tagged = embedJpegMetadata(baseline, metadata),
        read = async (bytes) => {
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })),
            c = document.createElement('canvas')
          c.width = bitmap.width
          c.height = bitmap.height
          c.getContext('2d').drawImage(bitmap, 0, 0)
          bitmap.close()
          return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data)
        }
      const signature = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0')
      let packet
      for (let at = 2; at < tagged.length;) {
        const marker = tagged[at + 1]
        if (marker === 218 || marker === 217) break
        const length = tagged[at + 2] * 256 + tagged[at + 3],
          payload = tagged.subarray(at + 4, at + 2 + length)
        if (marker === 225 && signature.every((byte, i) => payload[i] === byte))
          packet = new TextDecoder().decode(payload.subarray(signature.length))
        at += length + 2
      }
      const xml = new DOMParser().parseFromString(packet, 'application/xml'),
        dc = 'http://purl.org/dc/elements/1.1/'
      return {
        before: await read(baseline),
        after: await read(tagged),
        parsed: await parse(tagged, { xmp: true, mergeOutput: false }),
        rights: xml.getElementsByTagNameNS(dc, 'rights')[0].textContent,
        creator: xml.getElementsByTagNameNS(dc, 'creator')[0].textContent,
        xmlError: xml.getElementsByTagName('parsererror').length
      }
    },
    { exif: Array.from(metadata.exif), xmp: Array.from(xmp) }
  )
  assert.deepEqual(result.after, result.before)
  assert.equal(result.parsed.dc.creator, '测试摄影师')
  assert.equal(result.xmlError, 0)
  assert.equal(result.rights, '版权所有 © 测试摄影师 & OpenLR')
  assert.equal(result.creator, '测试摄影师')
})
