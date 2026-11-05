import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import UTIF from '../web/vendor/codecs/utif.js'
import { encodeColorPng, embedJpegProfile, encodeColorTiff } from '../web/color-containers.js'
import { serveWorkspace } from './browser-server.mjs'
import { COLOR_SPACES, makeColorProfile } from '../web/color-spaces.js'

// Deliberately opaque generated payloads test container fidelity, not ICC color science.
const profile = Uint8Array.from({ length: 170003 }, (_, index) => (index * 59 + (index >>> 8)) & 255)
function frame(width = 17, height = 513) {
  return {
    width,
    height,
    data: Uint8ClampedArray.from({ length: width * height * 4 }, (_, index) => (index * 37) & 255)
  }
}

function pngChunks(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    chunks = []
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset),
      end = offset + 12 + length
    assert.ok(end <= bytes.length)
    let crc = 0xffffffff
    for (const value of bytes.subarray(offset + 4, end - 4)) {
      crc ^= value
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    assert.equal(view.getUint32(end - 4), (crc ^ 0xffffffff) >>> 0)
    chunks.push({
      type: Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString(),
      data: bytes.subarray(offset + 8, end - 4)
    })
    offset = end
  }
  return chunks
}

function jpegSegments(bytes) {
  const segments = []
  for (let offset = 2; offset < bytes.length;) {
    assert.equal(bytes[offset++], 255)
    const marker = bytes[offset++]
    if (marker === 217 || marker === 218) break
    const length = bytes[offset] * 256 + bytes[offset + 1]
    segments.push({ marker, data: bytes.subarray(offset + 2, offset + length) })
    offset += length
  }
  return segments
}

function jpegProfile(bytes) {
  const segments = jpegSegments(bytes).filter(
    ({ marker, data }) => marker === 226 && Buffer.from(data.subarray(0, 12)).toString() === 'ICC_PROFILE\0'
  )
  assert.ok(segments.length)
  assert.ok(segments.every(({ data }, index) => data[12] === index + 1 && data[13] === segments.length))
  return Buffer.concat(segments.map(({ data }) => data.subarray(14)))
}

test('PNG writes independently inflated RGBA, complete profile and valid CRC without conflicting declarations', () => {
  const pixels = frame(),
    source = pixels.data.slice(),
    icc = profile.slice(),
    result = encodeColorPng(pixels, profile),
    chunks = pngChunks(result)
  assert.deepEqual(
    chunks.map(({ type }) => type),
    ['IHDR', 'iCCP', 'IDAT', 'IEND']
  )
  assert.equal(chunks[0].data[8], 8)
  assert.equal(chunks[0].data[9], 6)
  const embedded = chunks[1].data,
    terminator = embedded.indexOf(0)
  assert.equal(embedded[terminator + 1], 0)
  assert.deepEqual(inflateSync(embedded.subarray(terminator + 2)), Buffer.from(profile))
  const samples = inflateSync(
      Buffer.concat(chunks.filter(({ type }) => type === 'IDAT').map(({ data }) => data))
    ),
    stride = pixels.width * 4
  assert.equal(samples.length, (stride + 1) * pixels.height)
  for (let row = 0; row < pixels.height; row++) {
    assert.equal(samples[row * (stride + 1)], 0)
    assert.deepEqual(
      samples.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)),
      Buffer.from(source.subarray(row * stride, (row + 1) * stride))
    )
  }
  assert.deepEqual(pixels.data, source)
  assert.deepEqual(profile, icc)
})

test('TIFF dynamic ICC and multi-strip offsets independently decode exact straight-alpha RGBA', () => {
  for (const pixels of [frame(), frame(1, 1)]) {
    const source = pixels.data.slice(),
      result = encodeColorTiff(pixels, profile),
      buffer = result.buffer,
      ifd = UTIF.decode(buffer)[0]
    assert.deepEqual([...result.subarray(0, 4)], [73, 73, 42, 0])
    assert.deepEqual(ifd.t256, [pixels.width])
    assert.deepEqual(ifd.t257, [pixels.height])
    assert.deepEqual(ifd.t258, [8, 8, 8, 8])
    assert.deepEqual(ifd.t338, [2])
    UTIF.decodeImage(buffer, ifd)
    assert.deepEqual(Buffer.from(UTIF.toRGBA8(ifd)), Buffer.from(source))
    // Independent field inspection also verifies the UNDEFINED type and byte count.
    const view = new DataView(buffer),
      start = view.getUint32(4, true),
      count = view.getUint16(start, true)
    let found = false
    for (let i = 0; i < count; i++) {
      const at = start + 2 + i * 12
      if (view.getUint16(at, true) !== 34675) continue
      assert.equal(view.getUint16(at + 2, true), 7)
      assert.equal(view.getUint32(at + 4, true), profile.length)
      const offset = view.getUint32(at + 8, true)
      assert.equal(offset % 2, 0)
      assert.deepEqual(result.subarray(offset, offset + profile.length), profile)
      found = true
    }
    assert.ok(found)
    assert.deepEqual(pixels.data, source)
  }
})

test('JPEG replaces segmented profiles and stale EXIF/XMP while preserving scan bytes and transform markers', () => {
  const marker = (type, payload) =>
      Buffer.concat([
        Buffer.from([255, type, (payload.length + 2) >>> 8, (payload.length + 2) & 255]),
        Buffer.from(payload)
      ]),
    jfif = marker(224, Buffer.from('JFIF\0')),
    app14 = marker(238, Buffer.from('Adobe\0\0\0\0\0\x01')),
    unrelated = marker(226, Buffer.from('unrelated application data')),
    oldIcc = marker(226, Buffer.from('ICC_PROFILE\0\x01\x01old')),
    exif = marker(225, Buffer.from('Exif\0\0stale sRGB')),
    xmp = marker(225, Buffer.from('http://ns.adobe.com/xap/1.0/\0stale sRGB')),
    scan = Buffer.from([255, 218, 0, 2, 1, 255, 0, 2, 255, 208, 3]),
    input = Buffer.concat([
      Buffer.from([255, 216]),
      jfif,
      oldIcc,
      exif,
      xmp,
      app14,
      unrelated,
      scan,
      oldIcc,
      Buffer.from([255, 217])
    ]),
    original = Buffer.from(input),
    output = embedJpegProfile(input, profile),
    segments = jpegSegments(output)
  assert.deepEqual(jpegProfile(output), Buffer.from(profile))
  assert.equal(segments[0].marker, 224)
  assert.equal(
    segments.filter(
      ({ marker, data }) => marker === 226 && Buffer.from(data.subarray(0, 12)).toString() === 'ICC_PROFILE\0'
    ).length,
    3
  )
  assert.ok(!segments.some(({ marker }) => marker === 225))
  assert.ok(Buffer.from(output).includes(app14))
  assert.ok(Buffer.from(output).includes(unrelated))
  assert.ok(Buffer.from(output).includes(scan))
  assert.deepEqual(input, original)
  assert.deepEqual(jpegProfile(embedJpegProfile(output, Uint8Array.of(1, 2, 3))), Buffer.from([1, 2, 3]))
})

test('container adapters reject malformed bytes and incompatible frame contracts visibly', () => {
  for (const encode of [encodeColorPng, encodeColorTiff]) {
    assert.throws(() => encode({ width: 1, height: 1, data: new Float32Array(4) }, profile), /bytes/)
    assert.throws(() => encode({ width: 2, height: 1, data: Uint8Array.of(0) }, profile), /RGBA/)
    assert.throws(() => encode(frame(1, 1), new Uint8Array()), /ICC/)
  }
  assert.throws(() => embedJpegProfile(Uint8Array.of(1, 2), profile), /header/)
  assert.throws(() => embedJpegProfile(Uint8Array.of(255, 216, 255, 226, 255, 255), profile), /Truncated/)
  assert.throws(() => embedJpegProfile(Uint8Array.of(255, 216), profile), /end marker/)
})

test('independent Pillow decoders extract genuine profiles and exact underlying samples in all three containers', (t) => {
  const python = process.env.OPENLR_CMS_PYTHON || 'python',
    env = {
      ...process.env,
      PYTHONPATH: [resolve('.tools/color-cms'), process.env.PYTHONPATH]
        .filter(Boolean)
        .join(process.platform === 'win32' ? ';' : ':')
    },
    run = (code, input) =>
      spawnSync(python, ['-c', code], {
        env,
        input: input === undefined ? undefined : JSON.stringify(input),
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
      }),
    available = run('from PIL import ImageCms')
  if (available.status !== 0 && process.env.OPENLR_TEST_CMS !== '1')
    return t.skip('Pillow unavailable; OPENLR_TEST_CMS=1 requires independent container validation')
  assert.equal(available.status, 0, available.stderr)
  const fixture = run(`
import io,base64,json
from PIL import Image
image=Image.new('RGB',(17,9))
image.putdata([(i*13%256,i*29%256,i*47%256) for i in range(17*9)])
buffer=io.BytesIO(); image.save(buffer,format='JPEG',quality=93)
print(json.dumps({'jpeg':base64.b64encode(buffer.getvalue()).decode()}))
`)
  assert.equal(fixture.status, 0, fixture.stderr)
  const jpeg = Buffer.from(JSON.parse(fixture.stdout).jpeg, 'base64'),
    pixels = frame(17, 9),
    records = Object.keys(COLOR_SPACES).map((space) => {
      const icc = makeColorProfile(space)
      return {
        space,
        icc: Buffer.from(icc).toString('base64'),
        png: Buffer.from(encodeColorPng(pixels, icc)).toString('base64'),
        tiff: Buffer.from(encodeColorTiff(pixels, icc)).toString('base64'),
        jpeg: Buffer.from(embedJpegProfile(jpeg, icc)).toString('base64')
      }
    }),
    result = run(
      `
import io,base64,json,sys
from PIL import Image,ImageCms,__version__
p=json.load(sys.stdin)
decode=lambda value:base64.b64decode(value)
original=Image.open(io.BytesIO(decode(p['jpeg']))).tobytes()
destination=ImageCms.createProfile('sRGB')
for record in p['records']:
    for kind in ['png','tiff','jpeg']:
        image=Image.open(io.BytesIO(decode(record[kind])))
        assert image.size==(17,9),(record['space'],kind,image.size)
        assert image.info['icc_profile']==decode(record['icc']),(record['space'],kind,'ICC bytes')
        profile=ImageCms.ImageCmsProfile(io.BytesIO(image.info['icc_profile']))
        transform=ImageCms.buildTransform(profile,destination,'RGB','RGB')
        managed=ImageCms.applyTransform(image.convert('RGB'),transform)
        assert managed.size==image.size
        expected=original if kind=='jpeg' else bytes(p['pixels'])
        assert image.tobytes()==expected,(record['space'],kind,'underlying pixels')
print(json.dumps({'pillow':__version__,'lcms':ImageCms.core.littlecms_version,'decodedContainers':len(p['records'])*3}))
`,
      { jpeg: jpeg.toString('base64'), pixels: Array.from(pixels.data), records }
    )
  assert.equal(result.status, 0, result.stderr)
  t.diagnostic(result.stdout.trim())
})

test('Chrome independently decodes PNG and JPEG containers without changing their underlying samples', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const { encodeColorPng, embedJpegProfile } = await import('./color-containers.js'),
      canvas = document.createElement('canvas')
    canvas.width = canvas.height = 16
    const context = canvas.getContext('2d'),
      pixels = context.createImageData(16, 16),
      profile = Uint8Array.from({ length: 170003 }, (_, index) => index & 255)
    for (let i = 0; i < pixels.data.length; i += 4) pixels.data.set([i % 256, (i / 4) % 256, 97, 255], i)
    context.putImageData(pixels, 0, 0)
    const read = async (blob) => {
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' })
      context.clearRect(0, 0, 16, 16)
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      return Array.from(context.getImageData(0, 0, 16, 16).data)
    }
    const png = await read(new Blob([encodeColorPng(pixels, profile)], { type: 'image/png' })),
      jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9)),
      original = await read(jpeg),
      tagged = await read(
        new Blob([embedJpegProfile(await jpeg.arrayBuffer(), profile)], { type: 'image/jpeg' })
      )
    return { png, expected: Array.from(pixels.data), original, tagged }
  })
  assert.deepEqual(result.png, result.expected)
  assert.deepEqual(result.tagged, result.original)
})
