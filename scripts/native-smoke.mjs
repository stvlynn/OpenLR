import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readdir, readFile, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execute, parse, watch } from '../cli/openlr.mjs'
import { makeDng } from '../tests/fixtures/dng.mjs'
import { makeTiff } from '../tests/fixtures/tiff.mjs'
import { makePng, makePngFixture, exifOrientation } from '../tests/fixtures/png.mjs'
import { jxlInputCases } from '../tests/fixtures/jxl-input.mjs'
import { deflateSync } from 'node:zlib'
import { png as fixturePng } from '../tests/fixtures/merge-scene.js'
import UTIF from '../web/vendor/codecs/utif.js'
import { encodeColorTiff } from '../web/color-containers.js'
import { makeColorProfile, encodeSrgb } from '../web/color-spaces.js'
import { defaultOptions as avifOptions } from '../web/vendor/codecs/avif/meta.js'
import { readExifTool } from '../tests/exiftool.mjs'

const executable = process.argv[2]
if (!executable) throw Error('Pass the path to a built OpenLR executable')
const root = await mkdtemp(path.join(tmpdir(), 'openlr-native-'))
const session = path.join(root, 'agent.json')
const host = spawn(path.resolve(executable), [], {
  env: {
    ...process.env,
    OPENLR_EPHEMERAL: '1',
    OPENLR_AGENT_FILE: session,
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview2'),
    XDG_CONFIG_HOME: root,
    XDG_DATA_HOME: root,
    XDG_CACHE_HOME: root
  },
  stdio: 'inherit'
})
const exited = new Promise((resolve) => host.once('exit', (code, signal) => resolve({ code, signal })))
const call = (...args) => execute(parse([...args, '--session', session]))
function hasImageSignature(bytes, format) {
  if (format === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (format === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
  if (format === 'image/tiff')
    return (
      bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
      bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))
    )
  if (format === 'image/avif')
    return (
      bytes.subarray(4, 8).toString('latin1') === 'ftyp' &&
      bytes.subarray(8, 32).includes(Buffer.from('avif'))
    )
  return (
    bytes.subarray(0, 2).equals(Buffer.from([255, 10])) ||
    bytes.subarray(0, 12).equals(Buffer.from([0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10]))
  )
}
function readTiff16(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ifd = UTIF.decode(buffer)[0]
  UTIF.decodeImage(buffer, ifd)
  assert.deepEqual(ifd.t258, [16, 16, 16, 16])
  const view = new DataView(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength)
  return {
    width: ifd.width,
    height: ifd.height,
    samples: Uint16Array.from({ length: view.byteLength / 2 }, (_, i) => view.getUint16(i * 2, true))
  }
}
async function highDepthInputs() {
  const width = 128,
    height = 8,
    pixels = (depth) => {
      const maximum = 2 ** depth - 1,
        data = new Uint16Array(width * height * 4)
      for (let p = 0; p < width * height; p++) {
        const value = Math.floor(maximum / 4) + (p % width)
        data.set([value, value, value, maximum], p * 4)
      }
      data.set([1, 2, 3, 1], 0)
      data[7] = 0
      return { width, height, data }
    },
    tiff = pixels(16),
    sources = [
      {
        name: 'input16.tif',
        bits: 16,
        precision: 'uint16-source',
        pixels: tiff,
        bytes: encodeColorTiff(tiff, makeColorProfile('srgb'))
      }
    ],
    encoderUrl = new URL('../web/vendor/codecs/avif/codec/enc/avif_enc.js', import.meta.url),
    { default: createEncoder } = await import(encoderUrl),
    encoder = await createEncoder({ wasmBinary: await readFile(new URL('avif_enc.wasm', encoderUrl)) })
  sources.push({
    name: 'input16.png',
    bits: 16,
    precision: 'uint16-source',
    pixels: tiff,
    bytes: makePng({
      width,
      height,
      bits: 16,
      colorType: 6,
      data: tiff.data,
      srgb: 0,
      interlace: 1,
      filter: [0, 1, 2, 3, 4]
    })
  })
  const exif = new Uint8Array(26),
    exifView = new DataView(exif.buffer),
    rotated = new Uint16Array(tiff.data.length)
  exif.set([73, 73, 42, 0, 8, 0, 0, 0])
  exifView.setUint16(8, 1, true)
  exifView.setUint16(10, 274, true)
  exifView.setUint16(12, 3, true)
  exifView.setUint32(14, 1, true)
  exifView.setUint16(18, 6, true)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rotated.set(
        tiff.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
        (x * height + height - 1 - y) * 4
      )
  sources.push({
    name: 'oriented16.png',
    bits: 16,
    precision: 'uint16-source',
    pixels: { width: height, height: width, data: rotated },
    bytes: makePng({ width, height, bits: 16, colorType: 6, data: tiff.data, srgb: 0, exif })
  })
  const animation = new Uint8Array(8),
    frameControl = new Uint8Array(26),
    control = new DataView(frameControl.buffer),
    scanlines = makePngFixture({ width, height, bits: 16, colorType: 6, data: tiff.data }).scanlines,
    compressedFrame = deflateSync(scanlines),
    frameData = new Uint8Array(compressedFrame.length + 4)
  new DataView(animation.buffer).setUint32(0, 1)
  control.setUint32(4, width)
  control.setUint32(8, height)
  control.setUint16(20, 1)
  control.setUint16(22, 10)
  new DataView(frameData.buffer).setUint32(0, 1)
  frameData.set(compressedFrame, 4)
  sources.push({
    name: 'animation-first16.png',
    bits: 16,
    precision: 'uint16-source',
    pixels: tiff,
    bytes: makePng({
      width,
      height,
      bits: 16,
      colorType: 6,
      data: Uint16Array.from(tiff.data, (_, i) => (i % 4 === 0 || i % 4 === 3 ? 65535 : 0)),
      srgb: 0,
      beforeIdat: [['acTL', animation]],
      afterIdat: [
        ['fcTL', frameControl],
        ['fdAT', frameData]
      ]
    })
  })
  const colorMap = new Uint16Array(256 * 3),
    indices = Uint8Array.from({ length: width * height }, (_, i) => i % width),
    palettePixels = new Uint16Array(width * height * 4)
  for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) colorMap[c * 256 + i] = 16384 + i
  for (let i = 0; i < indices.length; i++) {
    const value = colorMap[indices[i]]
    palettePixels.set([value, value, value, 65535], i * 4)
  }
  sources.push({
    name: 'profiled-palette16.tif',
    bits: 16,
    precision: 'uint16-source',
    pixels: { width, height, data: palettePixels },
    bytes: makeTiff({
      width,
      height,
      photo: 3,
      bits: 8,
      channels: 1,
      data: indices,
      colorMap,
      profile: makeColorProfile('srgb')
    })
  })
  for (const bits of [10, 12]) {
    const frame = pixels(bits),
      bytes = encoder.encode(new Uint8Array(frame.data.buffer), width, height, {
        ...avifOptions,
        quality: 100,
        subsample: 3,
        speed: 10,
        bitDepth: bits,
        icc: new Uint8Array(),
        colorPrimaries: 1,
        transferCharacteristics: 13,
        matrixCoefficients: 0,
        fullRange: true
      })
    assert.ok(bytes?.length, `generated AVIF${bits} encoding`)
    sources.push({ name: `input${bits}.avif`, bits, precision: 'integer-source', pixels: frame, bytes })
  }
  const jxl = jxlInputCases().srgb16
  sources.push({
    name: 'input16.jxl',
    bits: 16,
    precision: 'integer-source',
    pixels: { width: jxl.width, height: jxl.height, data: jxl.data },
    bytes: await readFile(new URL('../tests/fixtures/jxl/srgb16.jxl', import.meta.url))
  })
  return sources
}
async function verifyNativeExportMetadata() {
  const previous = await call('state'),
    input = await readFile(new URL('../tests/fixtures/export-metadata.png', import.meta.url)),
    inputPath = path.join(root, 'export-metadata-source.png'),
    rights = '© 示例 & <rights> 📷 e\u0301',
    fields = {
      Make: 'OpenLR Fixture',
      Model: 'Generated Camera',
      LensModel: 'Generated 50mm',
      DateTimeOriginal: '2024-06-07T08:09:10.125+08:00',
      ExposureTime: 1 / 125,
      FNumber: 2.8,
      ISO: 200,
      FocalLength: 50,
      Artist: '创作者 Example',
      Copyright: rights
    },
    records = []
  await writeFile(inputPath, input)
  try {
    const imported = await call('import', inputPath)
    assert.deepEqual(imported.failed, [])
    assert.equal(imported.added.length, 1)
    const sourceId = imported.added[0],
      source = (await call('state')).photos.find((photo) => photo.id === sourceId)
    assert.deepEqual(
      source.metadata,
      fields,
      'Native input keeps Unicode XMP precedence and all supported capture fields'
    )
    assert.deepEqual(
      [source.width, source.height],
      [24, 32],
      'The fixture Orientation 6 is applied before editing'
    )
    await call('view', '--mode', 'detail')
    await call('edit', '--key', 'turn', '--value', '1')
    await call('edit', '--key', 'crop', '--value', JSON.stringify({ x: 0.125, y: 0.125, w: 0.75, h: 0.75 }))
    for (const version of [1, 2]) {
      await call('select', '--id', sourceId)
      await call('processing', '--version', String(version))
      const recipe = (await call('state')).photos.find((photo) => photo.id === sourceId).edit
      for (const [format, extension] of [
        ['image/jpeg', 'jpg'],
        ['image/png', 'png'],
        ['image/tiff', 'tif'],
        ['image/avif', 'avif'],
        ['image/jxl', 'jxl']
      ]) {
        let baselineColor, baselineWords
        for (const policy of ['none', 'copyright', 'supported']) {
          await call('select', '--id', sourceId)
          const label = `${version}-${extension}-${policy}`,
            exported = await call(
              'export',
              '--format',
              format,
              '--metadata',
              policy,
              '--quality',
              '1',
              '--colorSpace',
              'display-p3',
              '--maxSize',
              '16',
              '--output',
              path.join(root, `metadata-${label}.${extension}`)
            ),
            bytes = await readFile(exported.path),
            settings = await call('export-settings')
          assert.equal(settings.photo.format, format, label)
          assert.equal(settings.photo.colorSpace, 'display-p3', label)
          assert.equal(settings.photo.maxSize, 16, label)
          assert.equal(settings.photo.metadata, policy === 'none' ? undefined : policy, label)
          const repeated = await call(
            'export-previous',
            '--output',
            path.join(root, `metadata-${label}-previous.${extension}`)
          )
          assert.deepEqual(await readFile(repeated.path), bytes, label + ': previous export actual bytes')
          assert.deepEqual(
            await call('export-settings'),
            settings,
            label + ': previous export metadata acknowledgment'
          )
          if (version === 2 && format === 'image/png' && policy === 'copyright') {
            await assert.rejects(
              call('export', '--format', 'image/jpeg', '--metadata', 'supported', '--output', repeated.path),
              /EEXIST/
            )
            assert.deepEqual(await readFile(repeated.path), bytes)
            assert.deepEqual(
              await call('export-settings'),
              settings,
              'A refused output write keeps the previous metadata policy'
            )
          }
          if (format === 'image/tiff' && version === 2) {
            const decoded = readTiff16(bytes)
            assert.deepEqual([decoded.width, decoded.height], [16, 12], label)
            if (policy === 'none') baselineWords = decoded.samples
            else
              assert.deepEqual(
                decoded.samples,
                baselineWords,
                label + ': metadata cannot change TIFF16 samples'
              )
            assert.ok(
              decoded.samples.some((value, i) => i % 4 !== 3 && value % 257 !== 0),
              label + ': genuine 16-bit output words'
            )
          }
          const reimported = await call('import', exported.path)
          assert.deepEqual(reimported.failed, [], label)
          assert.equal(reimported.added.length, 1, label)
          const photo = (await call('state')).photos.find((photo) => photo.id === reimported.added[0]),
            expected = policy === 'supported' ? fields : policy === 'copyright' ? { Copyright: rights } : {}
          assert.deepEqual(photo.metadata, expected, label + ': actual native reimport semantics')
          assert.deepEqual(
            [photo.width, photo.height],
            [16, 12],
            label + ': no stale dimensions or second orientation'
          )
          const color = (await call('sample-color', '--x', '.5', '--y', '.5')).color
          if (policy === 'none') baselineColor = color
          else assert.equal(color, baselineColor, label + ': metadata cannot change decoded color')
          records.push({ version, format, policy, path: exported.path, label })
          assert.deepEqual(
            (await call('state')).photos.find((photo) => photo.id === sourceId).edit,
            recipe,
            label + ': source recipe unchanged'
          )
        }
      }
      await call('select', '--id', sourceId)
      const original = await call(
        'export',
        '--format',
        'original',
        '--output',
        path.join(root, `metadata-original-v${version}.png`)
      )
      assert.deepEqual(await readFile(original.path), input)
      assert.deepEqual(await readFile(inputPath), input)
    }
    const oracle = readExifTool([inputPath, ...records.map((record) => record.path)])
    if (!oracle) {
      console.log(
        'SKIP independent native metadata oracle: ExifTool is not installed; all 30 actual CLI exports/reimports and policy semantics still ran.'
      )
    } else {
      assert.equal(oracle.length, records.length + 1)
      const [fixture, ...outputs] = oracle
      assert.equal(fixture['IFD0:Orientation'], 6)
      assert.equal(fixture['GPS:GPSLatitude'], 1.25)
      assert.equal(fixture['XMP-crs:Exposure2012'], 3)
      assert.equal(fixture['XMP-dc:Subject'], 'Private fixture keyword')
      for (const [i, tags] of outputs.entries()) {
        const { policy, format, label } = records[i],
          supported = policy === 'supported'
        assert.equal(tags['XMP-dc:Rights'], policy === 'none' ? undefined : rights, label)
        assert.equal(tags['XMP-dc:Creator'], supported ? fields.Artist : undefined, label)
        assert.equal(tags['IFD0:Make'], supported ? fields.Make : undefined, label)
        assert.equal(tags['IFD0:Model'], supported ? fields.Model : undefined, label)
        assert.equal(tags['ExifIFD:LensModel'], supported ? fields.LensModel : undefined, label)
        for (const key of ['ExposureTime', 'FNumber', 'ISO', 'FocalLength'])
          assert.equal(tags['ExifIFD:' + key], supported ? fields[key] : undefined, label + ': ' + key)
        assert.equal(tags['ExifIFD:DateTimeOriginal'], supported ? '2024:06:07 08:09:10' : undefined, label)
        assert.equal(tags['ExifIFD:OffsetTimeOriginal'], supported ? '+08:00' : undefined, label)
        if (supported) assert.equal(String(tags['ExifIFD:SubSecTimeOriginal']), '125', label)
        if (policy !== 'none') {
          assert.equal(tags['IFD0:Orientation'], 1, label)
          assert.equal(tags['ExifIFD:ExifImageWidth'], 16, label)
          assert.equal(tags['ExifIFD:ExifImageHeight'], 12, label)
        }
        // ExifTool does not expose the ICC compressed inside JXL's codestream.
        // Its actual color interpretation is covered by reimport above and the
        // existing native five-space color checks; do not invent an ICC tag.
        if (format !== 'image/jxl') assert.match(tags['ICC_Profile:ProfileDescription'], /Display P3/, label)
        for (const key of Object.keys(tags)) {
          assert.ok(!key.startsWith('GPS:') && !key.startsWith('XMP-crs:'), label + ': excluded ' + key)
          assert.ok(
            !key.endsWith(':Warning') && !key.endsWith(':Error'),
            label + ': ' + key + ': ' + tags[key]
          )
        }
        assert.equal(tags['XMP-dc:Subject'], undefined, label)
      }
      console.log(
        'Native independent metadata oracle: ExifTool verified 30 output files, Unicode, supported capture fields, normalized dimensions/orientation and excluded GPS/private/edit fields.'
      )
    }
    console.log(
      'Native photo metadata: five formats × three policies × two processing versions; actual previous-export bytes/acknowledgment, reimport semantics, Linear TIFF16 and unchanged originals passed.'
    )
  } finally {
    if (previous.selected) await call('select', '--id', previous.selected)
  }
}

try {
  const end = Date.now() + 45000
  for (;;) {
    if (host.exitCode !== null || host.signalCode) throw Error('Host exited before agent connected')
    try {
      await access(session)
      break
    } catch {}
    if (Date.now() > end) throw Error('No agent session after 45 seconds')
    await delay(120)
  }
  await call('state', '--summary', 'true', '--timeout', '30')
  const file = path.join(root, 'sensor.dng'),
    data = Buffer.from(makeDng())
  await writeFile(file, data)
  const launch = await call('import', file)
  assert.deepEqual(launch.failed, [])
  assert.equal(launch.added.length, 1)
  await call('view', '--mode', 'detail')
  const processing = await call('processing', '--version', '2')
  assert.equal(processing.photos.find((p) => p.id === launch.added[0]).edit.processVersion, 2)
  const linearExport = await call(
    'export',
    '--format',
    'image/tiff',
    '--colorSpace',
    'prophoto-rgb',
    '--output',
    path.join(root, 'linear.tif')
  )
  const linearBytes = await readFile(linearExport.path)
  const linearBuffer = linearBytes.buffer.slice(
    linearBytes.byteOffset,
    linearBytes.byteOffset + linearBytes.byteLength
  )
  const linearTiff = UTIF.decode(linearBuffer)[0]
  UTIF.decodeImage(linearBuffer, linearTiff)
  assert.deepEqual(linearTiff.t258, [16, 16, 16, 16])
  assert.ok(linearTiff.t34675.length > 128)
  const samples = new DataView(linearTiff.data.buffer, linearTiff.data.byteOffset, linearTiff.data.byteLength)
  let lowBits = 0
  for (let i = 0; i < samples.byteLength; i += 8)
    for (let c = 0; c < 3; c++) if (samples.getUint16(i + c * 2, true) % 257) lowBits++
  assert.ok(lowBits > 100)
  await call('edit', '--key', 'Exposure', '--value', '1')
  const resetProcessing = await call('reset')
  assert.deepEqual(resetProcessing.photos.find((p) => p.id === launch.added[0]).edit, { processVersion: 2 })
  const resetExport = await call(
    'export',
    '--format',
    'image/tiff',
    '--colorSpace',
    'prophoto-rgb',
    '--output',
    path.join(root, 'linear-reset.tif')
  )
  assert.deepEqual(await readFile(resetExport.path), linearBytes)
  await call('processing', '--version', '1')
  console.log(
    'Native linear processing: actual RAW, TIFF16 low samples, profile, reset and version switching passed'
  )
  await call('edit', '--key', 'Exposure', '--value', '.5')
  await call('edit', '--key', 'turn', '--value', '1')
  const { result: state, frame } = await call(
    'rate',
    '--value',
    '4',
    '--capture',
    path.join(root, 'workspace.png')
  )
  const screen = await readFile(frame.path)
  assert.equal(screen.subarray(1, 4).toString(), 'PNG')
  assert.ok(screen.readUInt32BE(16) > 128 && screen.readUInt32BE(20) > 96)
  assert.equal(state.photos.find((p) => p.id === launch.added[0]).rating, 4)
  const preview = await call('preview', '--output', path.join(root, 'preview.png'))
  const png = await readFile(preview.path)
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [96, 128])
  const exported = await call('export', '--format', 'original', '--output', path.join(root, 'original.dng'))
  assert.deepEqual(await readFile(exported.path), data)
  assert.deepEqual(await call('export-settings'), { photo: { format: 'original' }, video: null })
  const repeatedOriginal = await call('export-previous', '--output', path.join(root, 'previous-original.dng'))
  assert.deepEqual(await readFile(repeatedOriginal.path), data)
  const exportOptions = { format: 'image/png', colorSpace: 'display-p3', maxSize: 64, watermark: 'Proof' },
    configuredExport = await call(
      'export',
      '--format',
      exportOptions.format,
      '--colorSpace',
      exportOptions.colorSpace,
      '--maxSize',
      String(exportOptions.maxSize),
      '--watermark',
      exportOptions.watermark,
      '--output',
      path.join(root, 'remembered.png')
    ),
    configuredBytes = await readFile(configuredExport.path)
  assert.deepEqual(await call('export-settings'), { photo: exportOptions, video: null })
  assert.deepEqual([configuredBytes.readUInt32BE(16), configuredBytes.readUInt32BE(20)], [48, 64])
  const repeatedExport = await call('export-previous', '--output', path.join(root, 'previous.png'))
  assert.deepEqual(await readFile(repeatedExport.path), configuredBytes)
  await assert.rejects(
    call('export', '--format', 'image/jpeg', '--quality', '0.5', '--output', repeatedExport.path),
    /EEXIST/
  )
  assert.deepEqual(await readFile(repeatedExport.path), configuredBytes)
  assert.deepEqual(await call('export-settings'), { photo: exportOptions, video: null })
  const afterRefusal = await call(
    'export-previous',
    '--output',
    path.join(root, 'previous-after-refusal.png')
  )
  assert.deepEqual(await readFile(afterRefusal.path), configuredBytes)
  const preservedExport = await call(
    'export',
    '--format',
    'original',
    '--output',
    path.join(root, 'preserved-export-original.dng')
  )
  assert.deepEqual(await readFile(preservedExport.path), data)
  console.log(
    'Native previous export: shared settings, original bytes, rendered options and refused-write retention passed'
  )
  await call('copy-edits')
  const historyBytes = makePng({
      width: 8,
      height: 6,
      bits: 8,
      colorType: 6,
      data: Uint8Array.from({ length: 8 * 6 * 4 }, (_, i) => [83, 123, 145, 255][i % 4])
    }),
    historyFile = path.join(root, 'history-target.png'),
    neutralFile = path.join(root, 'history-neutral.png')
  await writeFile(historyFile, historyBytes)
  await writeFile(neutralFile, historyBytes)
  const historyTarget = (await call('import', historyFile)).added[0],
    neutralTarget = (await call('import', neutralFile)).added[0],
    historyPhoto = async (id = historyTarget) => (await call('state')).photos.find((photo) => photo.id === id)
  await call('select', '--id', historyTarget)
  await call('view', '--mode', 'grid')
  await call('rate', '--value', '3', '--advance', 'false')
  await call('paste-edits')
  await call('history-undo')
  assert.equal((await historyPhoto()).edit.Exposure, undefined)
  assert.equal((await historyPhoto()).rating, 3)
  await call('history-redo')
  assert.equal((await historyPhoto()).edit.Exposure, 0.5)
  await call('flag', '--value', 'reject', '--advance', 'false')
  await call('history-undo')
  assert.equal((await historyPhoto()).flag, '')
  await call('history-undo')
  assert.equal((await historyPhoto()).edit.Exposure, undefined)
  await call('history-undo')
  assert.equal((await historyPhoto()).rating, 0)
  await call('history-redo')
  assert.equal((await historyPhoto()).rating, 3)
  assert.equal((await historyPhoto()).edit.Exposure, undefined)
  await call('history-redo')
  assert.equal((await historyPhoto()).edit.Exposure, 0.5)
  await call('history-redo')
  assert.equal((await historyPhoto()).flag, 'reject')
  await call('view', '--mode', 'detail')
  assert.throws(() => call('edit', '--key', 'Exposure', '--value', '1000'), /between -5 and 5/)
  await call('history-undo')
  assert.equal((await historyPhoto()).edit.Exposure, undefined)
  assert.equal((await historyPhoto()).rating, 3)
  assert.equal((await historyPhoto()).flag, 'reject')
  await call('history-redo')
  await call('select', '--id', neutralTarget)
  await call('edit', '--key', 'Contrast', '--value', '10')
  await call('select', '--id', historyTarget)
  await call('view', '--mode', 'grid')
  await call('history-undo')
  assert.equal((await historyPhoto()).edit.Exposure, undefined)
  assert.equal((await historyPhoto(neutralTarget)).edit.Contrast, 10)
  await call('history-redo')
  const historyOriginal = await call(
    'export',
    '--format',
    'original',
    '--output',
    path.join(root, 'history-original.png')
  )
  assert.deepEqual(await readFile(historyOriginal.path), Buffer.from(historyBytes))
  await call('select', '--id', neutralTarget)
  await call('reset')
  await call('processing', '--version', '2')
  assert.deepEqual((await historyPhoto(neutralTarget)).edit, { processVersion: 2 })
  await call('filter', '--edited', 'no')
  const uneditedAlbum = await call('album', '--name', 'Native neutral recipes', '--smart', 'true')
  await call('filter', '--edited', 'any')
  await call('scope', '--id', uneditedAlbum.id)
  const uneditedState = await call('state')
  assert.ok(uneditedState.photos.some((photo) => photo.id === neutralTarget))
  assert.ok(!uneditedState.photos.some((photo) => photo.id === historyTarget))
  await call('scope', '--id', 'all')
  await call('filter', '--edited', 'yes')
  const editedAlbum = await call('album', '--name', 'Native actual adjustments', '--smart', 'true')
  await call('filter', '--edited', 'any')
  await call('scope', '--id', editedAlbum.id)
  const editedState = await call('state')
  assert.ok(editedState.photos.some((photo) => photo.id === historyTarget))
  assert.ok(!editedState.photos.some((photo) => photo.id === neutralTarget))
  await call('scope', '--id', 'all')
  await call('select', '--id', launch.added[0])
  await call('view', '--mode', 'detail')
  assert.equal((await historyPhoto(launch.added[0])).edit.Exposure, 0.5)
  assert.equal((await historyPhoto(launch.added[0])).edit.turn, 1)
  console.log(
    'Native history: shared undo/redo order, active photo, Detail, failed command, original bytes and neutral smart albums passed'
  )
  const revisions = []
  await watch({ session, count: 2, images: path.join(root, 'observed') }, async (update) => {
    assert.equal(update.result.selected, launch.added[0])
    const bytes = await readFile(update.frame.path)
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
    revisions.push(update.revision)
    if (revisions.length === 1) {
      await call('lens-profiles', '--query', 'PowerShot')
      await call('sample-color', '--x', '0.5', '--y', '0.5')
      await call('flag', '--value', 'pick')
    } else assert.equal(update.result.photo.flag, 'pick')
  })
  assert.equal(revisions[1], revisions[0] + 1)
  const committedCrop = { x: 0.125, y: 0.125, w: 0.5, h: 0.5 }
  await call('edit', '--key', 'crop', '--value', JSON.stringify(committedCrop))
  await call('crop-tool')
  const { cropDraft: initialCrop } = await call(
    'crop-drag',
    '--grip',
    'new',
    '--x1',
    '0.25',
    '--y1',
    '0.25',
    '--x2',
    '0.75',
    '--y2',
    '0.625'
  )
  assert.deepEqual(initialCrop, { x: 0.25, y: 0.25, w: 0.5, h: 0.375 })
  const beforeGuide = await call(
    'export',
    '--format',
    'image/png',
    '--output',
    path.join(root, 'before-guide.png')
  )
  const guide = await call(
    'crop-guide',
    '--type',
    'golden-spiral',
    '--orientation',
    '1',
    '--capture',
    path.join(root, 'crop-guide.png')
  )
  assert.deepEqual(guide.result.cropGuide, { type: 'golden-spiral', orientation: 1 })
  assert.equal((await readFile(guide.frame.path)).subarray(1, 4).toString(), 'PNG')
  const guideState = await call('state', '--summary', 'true')
  assert.deepEqual(guideState.cropGuide, guide.result.cropGuide)
  assert.deepEqual(guideState.cropDraft, initialCrop)
  const afterGuide = await call(
    'export',
    '--format',
    'image/png',
    '--output',
    path.join(root, 'after-guide.png')
  )
  assert.deepEqual(await readFile(afterGuide.path), await readFile(beforeGuide.path))
  const moved = await call('crop-nudge', '--dx', '1', '--dy', '0', '--capture', path.join(root, 'crop.png'))
  assert.ok(moved.result.cropDraft.x > initialCrop.x)
  assert.equal(moved.result.cropDraft.y, initialCrop.y)
  assert.equal((await readFile(moved.frame.path)).subarray(1, 4).toString(), 'PNG')
  await call('crop-cancel')
  const canceled = await call('state')
  assert.equal(canceled.cropDraft, null)
  assert.deepEqual(canceled.photos.find((p) => p.id === canceled.selected).edit.crop, committedCrop)
  const personPath = new URL('../tests/fixtures/ai/astronaut.png', import.meta.url)
  const { fileURLToPath } = await import('node:url')
  await call('import', fileURLToPath(personPath))
  const mask = await call('ai-mask', '--target', 'person')
  assert.ok(mask?.id || (await call('state')).photos.some((p) => p.edit?.localTools?.masks?.length))
  const { localSelection } = await call('state', '--summary', 'true')
  assert.ok(localSelection.id)
  await call('local-select', '--args', JSON.stringify({ id: '' }))
  const selectedMask = await call(
    'local-select',
    '--id',
    localSelection.id,
    '--capture',
    path.join(root, 'selected-mask.png')
  )
  assert.deepEqual(selectedMask.result, localSelection)
  assert.equal((await readFile(selectedMask.frame.path)).subarray(1, 4).toString(), 'PNG')
  const beforeTool = await call('state'),
    beforeToolEdit = beforeTool.photos.find((photo) => photo.id === beforeTool.selected).edit
  await call('crop-tool')
  const activatedTool = await call(
    'local-tool',
    '--tool',
    'brush',
    '--capture',
    path.join(root, 'local-brush.png')
  )
  assert.equal((await readFile(activatedTool.frame.path)).subarray(1, 4).toString(), 'PNG')
  assert.equal((await call('state')).cropping, false)
  await call('compare')
  for (const tool of ['linear', 'radial', 'clone', 'heal', 'off']) {
    await call('local-tool', '--tool', tool)
    const full = await call('state'),
      summary = await call('state', '--summary', 'true')
    assert.equal(full.localTool, tool)
    assert.equal(summary.localTool, tool)
    assert.equal(full.mode, 'detail')
    assert.equal(full.compare, false)
    assert.deepEqual(full.photos.find((photo) => photo.id === full.selected).edit, beforeToolEdit)
  }
  await call('local-select', '--id', localSelection.id)
  console.log(
    'Native local tools: shared activation exits crop/compare, full/summary tool identity, actual capture and unchanged recipe passed.'
  )
  const sample = await call('export', '--format', 'image/tiff', '--output', path.join(root, 'astronaut.tif'))
  assert.ok((await readFile(sample.path)).length > 100000)
  const objects = new Map()
  const dav = createServer(async (req, res) => {
    const stored = objects.get(req.url)
    if (req.method === 'GET') {
      if (!stored) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { ETag: stored.tag }).end(stored.bytes)
      return
    }
    if (req.method !== 'PUT') {
      res.writeHead(405).end()
      return
    }
    if (
      (req.headers['if-none-match'] === '*' && stored) ||
      (req.headers['if-match'] && req.headers['if-match'] !== stored?.tag)
    ) {
      res.writeHead(412).end()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    objects.set(req.url, { tag: '"' + crypto.randomUUID() + '"', bytes: Buffer.concat(chunks) })
    res.writeHead(201).end()
  })
  await new Promise((resolve) => dav.listen(0, '127.0.0.1', resolve))
  try {
    const endpoint = 'http://127.0.0.1:' + dav.address().port + '/library/'
    const synced = await call('sync', '--endpoint', endpoint)
    assert.equal(synced.synced, true)
    const manifest = JSON.parse(objects.get('/library/openlr-manifest.json').bytes)
    assert.equal(manifest.photos[launch.added[0]].flag, 'pick')
    assert.deepEqual(objects.get('/library/openlr-' + launch.added[0] + '.original').bytes, data)
    assert.equal((await call('sync', '--endpoint', endpoint)).uploaded, 0)
  } finally {
    dav.closeAllConnections()
    dav.close()
  }
  const colors = [
    [180, 60, 40],
    [45, 160, 70],
    [50, 70, 190],
    [128, 128, 128]
  ]
  const colorPixels = new Uint8ClampedArray(160 * 80 * 4)
  for (let y = 0; y < 80; y++)
    for (let x = 0; x < 160; x++) colorPixels.set([...colors[Math.floor(x / 40)], 255], (y * 160 + x) * 4)
  const colorSource = path.join(root, 'color-source.png')
  const colorBytes = fixturePng({ width: 160, height: 80, data: colorPixels })
  await writeFile(colorSource, colorBytes)
  const colorAsset = (await call('import', colorSource)).added[0]
  await call('edit', '--key', 'flip', '--value', 'true')
  const editedColors = colors.toReversed()
  const beforeColorExport = (await call('state')).photos.find((photo) => photo.id === colorAsset).edit
  const colorResults = []
  for (const colorSpace of ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020']) {
    for (const [format, extension] of [
      ['image/png', 'png'],
      ['image/tiff', 'tif'],
      ['image/jpeg', 'jpg'],
      ['image/avif', 'avif'],
      ['image/jxl', 'jxl']
    ]) {
      await call('select', '--id', colorAsset)
      const file = await call(
        'export',
        '--format',
        format,
        '--colorSpace',
        colorSpace,
        '--quality',
        '1',
        '--output',
        path.join(root, `${colorSpace}.${extension}`)
      )
      assert.equal(file.mimeType, format)
      assert.ok(hasImageSignature(await readFile(file.path), format), `${colorSpace} ${format}: signature`)
      const imported = await call('import', file.path)
      assert.equal(imported.failed.length, 0)
      assert.equal(imported.added.length, 1)
      const errors = []
      for (let i = 0; i < colors.length; i++) {
        const { color } = await call('sample-color', '--x', String((i + 0.5) / 4), '--y', '0.5')
        editedColors[i].forEach((value, c) =>
          errors.push(Math.abs(parseInt(color.slice(c * 2 + 1, c * 2 + 3), 16) - value))
        )
      }
      const maximum = Math.max(...errors)
      assert.ok(maximum <= (format === 'image/jpeg' ? 5 : 3), `${colorSpace} ${format}: ${maximum}`)
      colorResults.push({ colorSpace, format, maximum })
    }
  }
  assert.equal(colorResults.length, 25)
  await call('select', '--id', colorAsset)
  for (const format of [
    'original',
    'original-settings',
    'image/x-adobe-dng',
    'video/mp4',
    'application/rdf+xml'
  ]) {
    await assert.rejects(async () => call('export', '--format', format, '--colorSpace', 'display-p3'))
  }
  const preservedColor = await call(
    'export',
    '--format',
    'original',
    '--output',
    path.join(root, 'color-original.png')
  )
  assert.deepEqual(await readFile(preservedColor.path), colorBytes)
  assert.deepEqual(
    (await call('state')).photos.find((photo) => photo.id === colorAsset).edit,
    beforeColorExport
  )
  assert.deepEqual(await readFile(colorSource), colorBytes)
  console.log('Native color-managed export/import:', JSON.stringify(colorResults))
  const inputResults = []
  for (const source of await highDepthInputs()) {
    const inputPath = path.join(root, source.name),
      originalBytes = Buffer.from(source.bytes),
      originalSamples = source.pixels.data.slice()
    await writeFile(inputPath, originalBytes)
    const imported = await call('import', inputPath)
    assert.deepEqual(imported.failed, [])
    assert.equal(imported.added.length, 1)
    await call('view', '--mode', 'detail')
    await call('processing', '--version', '2')
    const active = await call('state', '--summary', 'true')
    assert.equal(active.selected, imported.added[0])
    assert.equal(active.processing.version, 2)
    assert.equal(active.processing.input.sourceBits, source.bits)
    assert.equal(active.processing.input.precision, source.precision)
    assert.equal(active.processing.input.compatibilityReason, undefined)
    const output = await call(
        'export',
        '--format',
        'image/tiff',
        '--colorSpace',
        'srgb',
        '--output',
        path.join(root, source.name + '-linear.tif')
      ),
      decoded = readTiff16(await readFile(output.path))
    assert.deepEqual([decoded.width, decoded.height], [source.pixels.width, source.pixels.height])
    assert.equal(decoded.samples.length, originalSamples.length)
    let maximumError = 0,
      lowSamples = 0,
      hiddenDifference = false
    const byteGroups = new Map(),
      maximum = 2 ** source.bits - 1
    for (let i = 0; i < decoded.samples.length; i++) {
      maximumError = Math.max(
        maximumError,
        Math.abs(decoded.samples[i] - Math.round((originalSamples[i] * 65535) / maximum))
      )
      if (i % 4 === 0) {
        const sample = decoded.samples[i],
          byte = Math.round(sample / 257)
        if (sample % 257) lowSamples++
        if (byteGroups.has(byte) && byteGroups.get(byte) !== sample) hiddenDifference = true
        byteGroups.set(byte, sample)
      }
    }
    assert.ok(maximumError <= 4, `${source.name}: TIFF16 source code error ${maximumError}`)
    assert.ok(lowSamples > 100, `${source.name}: low source bits retained`)
    assert.equal(hiddenDifference, true, `${source.name}: differences within one display byte retained`)
    const preserved = await call(
      'export',
      '--format',
      'original',
      '--output',
      path.join(root, 'original-' + source.name)
    )
    assert.deepEqual(await readFile(preserved.path), originalBytes)
    assert.deepEqual(await readFile(inputPath), originalBytes)
    assert.deepEqual(source.pixels.data, originalSamples)
    inputResults.push({
      source: source.name,
      format: source.name.split('.').at(-1),
      sourceBits: source.bits,
      decodedPrecision: active.processing.input.precision,
      colorTransform: active.processing.input.colorTransform,
      maximumTiff16CodeError: maximumError,
      lowSamples,
      hiddenDifference,
      originalPreserved: true
    })
  }
  console.log('Native high-depth input → Linear → TIFF16:', JSON.stringify(inputResults))
  const jxlFloat = await readFile(new URL('../tests/fixtures/jxl/linear-float.jxl', import.meta.url)),
    jxlFloatPath = path.join(root, 'linear-float.jxl')
  await writeFile(jxlFloatPath, jxlFloat)
  const jxlFloatImport = await call('import', jxlFloatPath)
  assert.deepEqual(jxlFloatImport.failed, [])
  assert.equal(jxlFloatImport.added.length, 1)
  await call('view', '--mode', 'detail')
  await call('processing', '--version', '2')
  const jxlFloatState = await call('state', '--summary', 'true')
  assert.equal(jxlFloatState.processing.input.sourceBits, 32)
  assert.equal(jxlFloatState.processing.input.sourceExponentBits, 8)
  assert.equal(jxlFloatState.processing.input.outputBits, 32)
  assert.equal(jxlFloatState.processing.input.precision, 'float-source')
  const clipped = await call(
    'export',
    '--format',
    'image/tiff',
    '--output',
    path.join(root, 'jxl-float-terminal.tif')
  )
  assert.equal(readTiff16(await readFile(clipped.path)).samples[2], 65535)
  await call('edit', '--key', 'Exposure', '--value', '-2')
  const recoveredFloat = await call(
      'export',
      '--format',
      'image/tiff',
      '--output',
      path.join(root, 'jxl-float-recovered.tif')
    ),
    recoveredBlue = readTiff16(await readFile(recoveredFloat.path)).samples[2],
    expectedBlue = Math.round(encodeSrgb(1.5 / 4) * 65535),
    floatCodeError = Math.abs(recoveredBlue - expectedBlue)
  assert.ok(floatCodeError <= 4, `JPEG XL float highlight recovery code error ${floatCodeError}`)
  assert.ok(
    recoveredBlue > Math.round(encodeSrgb(1 / 4) * 65535) + 5000,
    'source highlight was not clipped before the edit'
  )
  const preservedFloat = await call(
    'export',
    '--format',
    'original',
    '--output',
    path.join(root, 'original-linear-float.jxl')
  )
  assert.deepEqual(await readFile(preservedFloat.path), jxlFloat)
  assert.deepEqual(await readFile(jxlFloatPath), jxlFloat)
  console.log(
    'Native JPEG XL float highlight recovery:',
    JSON.stringify({
      sourceBits: 32,
      sourceExponentBits: 8,
      recoveredBlue,
      expectedBlue,
      maximumTiff16CodeError: floatCodeError,
      originalPreserved: true
    })
  )
  // Run last so the extra imported records and remembered settings cannot
  // affect any pre-existing native smoke baseline.
  await verifyNativeExportMetadata()
  const orientationOrders = [
      [0, 1, 2, 3, 4, 5],
      [1, 0, 3, 2, 5, 4],
      [5, 4, 3, 2, 1, 0],
      [4, 5, 2, 3, 0, 1],
      [0, 2, 4, 1, 3, 5],
      [4, 2, 0, 5, 3, 1],
      [5, 3, 1, 4, 2, 0],
      [1, 3, 5, 0, 2, 4]
    ],
    orientationValues = [32, 64, 96, 128, 160, 192]
  for (const [index, order] of orientationOrders.entries()) {
    const bytes = makePng({
        width: 2,
        height: 3,
        bits: 8,
        colorType: 2,
        srgb: 0,
        data: orientationValues.flatMap((v) => [v, v, v]),
        exif: exifOrientation(index + 1)
      }),
      source = path.join(root, `orientation-${index + 1}.png`)
    await writeFile(source, bytes)
    const imported = await call('import', source)
    assert.deepEqual(imported.failed, [])
    const state = await call('state'),
      photo = state.photos.find((p) => p.id === imported.added[0]),
      dimensions = index >= 4 ? [3, 2] : [2, 3]
    assert.deepEqual([photo.width, photo.height], dimensions)
    for (const version of [1, 2]) {
      await call('processing', '--version', String(version))
      const exported = await call(
          'export',
          '--format',
          'image/tiff',
          '--output',
          path.join(root, `orientation-${index + 1}-${version}.tif`)
        ),
        encoded = await readFile(exported.path),
        buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
        ifd = UTIF.decode(buffer)[0]
      UTIF.decodeImage(buffer, ifd)
      assert.deepEqual([ifd.width, ifd.height], dimensions)
      const rgba = UTIF.toRGBA8(ifd)
      order.forEach((source, pixel) => {
        for (let channel = 0; channel < 3; channel++)
          assert.ok(Math.abs(rgba[pixel * 4 + channel] - orientationValues[source]) <= 1)
        assert.equal(rgba[pixel * 4 + 3], 255)
      })
    }
    const original = await call(
      'export',
      '--format',
      'original',
      '--output',
      path.join(root, `orientation-original-${index + 1}.png`)
    )
    assert.deepEqual(await readFile(original.path), Buffer.from(bytes))
  }
  console.log(
    'Native PNG orientation: all eight directions, both processing versions, TIFF pixels and original bytes passed.'
  )
  const sharpenInput = makePng({
      width: 64,
      height: 48,
      bits: 8,
      colorType: 2,
      srgb: 0,
      data: Array.from({ length: 64 * 48 * 3 }, (_, i) => {
        const pixel = Math.floor(i / 3),
          x = pixel % 64,
          y = Math.floor(pixel / 64)
        return Math.round(120 + 45 * Math.sin(x * 0.5) + 25 * Math.cos(y * 0.3))
      })
    }),
    sharpenPath = path.join(root, 'output-sharpening.png')
  await writeFile(sharpenPath, sharpenInput)
  const sharpenImport = await call('import', sharpenPath)
  assert.deepEqual(sharpenImport.failed, [])
  const sharpenId = sharpenImport.added[0]
  for (const version of [1, 2]) {
    await call('select', '--id', sharpenId)
    await call('processing', '--version', String(version))
    const before = await call('preview', '--output', path.join(root, `sharp-before-${version}.png`)),
      recipe = (await call('state')).photos.find((photo) => photo.id === sharpenId).edit
    for (const [format, extension] of [
      ['image/png', 'png'],
      ['image/jpeg', 'jpg'],
      ['image/tiff', 'tif'],
      ['image/avif', 'avif'],
      ['image/jxl', 'jxl']
    ]) {
      const decoded = []
      for (const level of ['none', 'standard']) {
        await call('select', '--id', sharpenId)
        const output = await call(
            'export',
            '--format',
            format,
            '--quality',
            '1',
            '--maxSize',
            '32',
            '--colorSpace',
            'display-p3',
            '--outputSharpening',
            level,
            '--output',
            path.join(root, `sharp-${version}-${level}.${extension}`)
          ),
          previous = await call(
            'export-previous',
            '--output',
            path.join(root, `sharp-previous-${version}-${level}.${extension}`)
          )
        assert.deepEqual(await readFile(previous.path), await readFile(output.path))
        const settings = (await call('export-settings')).photo
        assert.equal(settings.outputSharpening ?? 'none', level)
        const imported = await call('import', output.path)
        assert.deepEqual(imported.failed, [])
        await call('processing', '--version', '1')
        const sampled = await call(
            'export',
            '--format',
            'image/tiff',
            '--output',
            path.join(root, `sharp-readback-${version}-${level}-${extension}.tif`)
          ),
          bytes = await readFile(sampled.path),
          buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          ifd = UTIF.decode(buffer)[0]
        UTIF.decodeImage(buffer, ifd)
        assert.deepEqual([ifd.width, ifd.height], [32, 24])
        decoded.push(UTIF.toRGBA8(ifd))
      }
      assert.ok(
        decoded[0].some((value, i) => i % 4 !== 3 && value !== decoded[1][i]),
        `Output sharpening must change actual ${format} pixels in processing ${version}`
      )
    }
    await call('select', '--id', sharpenId)
    const after = await call('preview', '--output', path.join(root, `sharp-after-${version}.png`))
    assert.deepEqual(await readFile(after.path), await readFile(before.path))
    assert.deepEqual((await call('state')).photos.find((photo) => photo.id === sharpenId).edit, recipe)
  }
  const sharpenOriginal = await call(
    'export',
    '--format',
    'original',
    '--output',
    path.join(root, 'sharp-original.png')
  )
  assert.deepEqual(await readFile(sharpenOriginal.path), Buffer.from(sharpenInput))
  await assert.rejects(
    async () => call('export', '--format', 'original', '--outputSharpening', 'high'),
    /does not support output sharpening/
  )
  console.log(
    'Native output sharpening: both processing versions, five actual formats, pixel readback, previous settings, unchanged preview/recipe/original and preservation rejection passed.'
  )
  const batchDirectory = path.join(root, 'batch-exports'),
    batchIds = [],
    batchExpected = new Map(),
    batchOriginals = new Map()
  await mkdir(batchDirectory)
  await writeFile(path.join(batchDirectory, 'shared.tif'), 'existing destination')
  for (const version of [1, 2]) {
    const directory = path.join(root, 'batch-source-' + version)
    await mkdir(directory)
    const sourcePath = path.join(directory, 'shared.png'),
      sourceBytes = makePng({
        width: 40,
        height: 24,
        bits: 8,
        colorType: 2,
        srgb: 0,
        data: Array.from({ length: 40 * 24 * 3 }, (_, i) => 40 + version * 25 + (Math.floor(i / 3) % 40) * 2)
      })
    await writeFile(sourcePath, sourceBytes)
    const imported = await call('import', sourcePath)
    assert.deepEqual(imported.failed, [])
    assert.equal(imported.added.length, 1)
    const id = imported.added[0]
    batchIds.push(id)
    batchOriginals.set(id, sourceBytes)
    await call('processing', '--version', String(version))
    await call('edit', '--key', 'Exposure', '--value', String(version * 0.2))
    const reference = await call(
      'export',
      '--format',
      'image/tiff',
      '--maxSize',
      '20',
      '--colorSpace',
      'display-p3',
      '--outputSharpening',
      'standard',
      '--output',
      path.join(root, 'batch-reference-' + version + '.tif')
    )
    batchExpected.set(id, await readFile(reference.path))
  }
  await call('sort', '--order', 'name', '--direction', 'asc')
  await call('select-many', '--ids', JSON.stringify([...batchIds].reverse()))
  await call('view', '--mode', 'detail')
  const batchBefore = await call('state'),
    batchOrder = batchBefore.photos.filter((photo) => batchIds.includes(photo.id)).map((photo) => photo.id),
    batchPreviewBefore = await call('preview', '--output', path.join(root, 'batch-before.png'))
  const batchCapture = await call(
      'export-selection',
      '--format',
      'image/tiff',
      '--maxSize',
      '20',
      '--colorSpace',
      'display-p3',
      '--outputSharpening',
      'standard',
      '--output-dir',
      batchDirectory,
      '--capture',
      path.join(root, 'batch-workspace.png')
    ),
    batchResult = batchCapture.result
  assert.equal((await readFile(batchCapture.frame.path)).subarray(1, 4).toString(), 'PNG')
  assert.equal(batchCapture.selected, batchBefore.selected)
  assert.equal(batchResult.total, 2)
  assert.equal(batchResult.cancelled, false)
  assert.deepEqual(
    batchResult.files.map((file) => file.id),
    batchOrder
  )
  assert.equal(new Set(batchResult.files.map((file) => file.filename.toLowerCase())).size, 2)
  assert.ok(batchResult.files.every((file) => file.filename.toLowerCase() !== 'shared.tif'))
  assert.equal(await readFile(path.join(batchDirectory, 'shared.tif'), 'utf8'), 'existing destination')
  for (const file of batchResult.files) {
    const bytes = await readFile(file.path),
      buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      ifd = UTIF.decode(buffer)[0]
    UTIF.decodeImage(buffer, ifd)
    assert.deepEqual([ifd.width, ifd.height], [20, 12])
    assert.deepEqual(bytes, batchExpected.get(file.id))
    assert.equal(file.bytes, bytes.length)
    assert.equal(path.dirname(file.path), batchDirectory)
  }
  const batchAfter = await call('state'),
    batchPreviewAfter = await call('preview', '--output', path.join(root, 'batch-after.png'))
  for (const key of ['selected', 'selection', 'photos', 'mode', 'compare'])
    assert.deepEqual(batchAfter[key], batchBefore[key], key)
  assert.deepEqual(await readFile(batchPreviewAfter.path), await readFile(batchPreviewBefore.path))
  assert.equal((await call('export-settings')).photo.outputSharpening, 'standard')
  const batchAgain = await call('export-selection', '--previous', 'true', '--output-dir', batchDirectory)
  assert.equal(batchAgain.files.length, 2)
  for (const file of batchAgain.files) assert.deepEqual(await readFile(file.path), batchExpected.get(file.id))
  assert.equal((await readdir(batchDirectory)).length, 5)
  for (const id of batchIds) {
    await call('select', '--id', id)
    const original = await call(
      'export',
      '--format',
      'original',
      '--output',
      path.join(root, 'batch-original-' + id + '.png')
    )
    assert.deepEqual(await readFile(original.path), Buffer.from(batchOriginals.get(id)))
  }
  console.log(
    'Native batch export: actual folder files, collision preservation, mixed processing versions, TIFF pixels, previous settings, unchanged selection/preview/recipes and original bytes passed.'
  )
  const controlDirectory = path.join(root, 'controlled-exports'),
    controlIds = []
  await mkdir(controlDirectory)
  const controlPng = Buffer.from(
    makePng({
      width: 32,
      height: 24,
      bits: 8,
      colorType: 2,
      srgb: 0,
      data: new Uint8Array(32 * 24 * 3).fill(95)
    })
  )
  // Trailing original bytes are opaque to PNG display decoding. The generated
  // 64 MiB payload gives actual IPC chunks to observe without a runtime test hook.
  for (const name of ['control-a.png', 'control-b.png', 'control-c.png']) {
    const input = path.join(root, name)
    await writeFile(
      input,
      name === 'control-b.png' ? Buffer.concat([controlPng, Buffer.alloc(64 * 1024 * 1024, 73)]) : controlPng
    )
    const imported = await call('import', input)
    assert.deepEqual(imported.failed, [])
    controlIds.push(imported.added[0])
  }
  await call('sort', '--order', 'name', '--direction', 'asc')
  await call('select-many', '--ids', JSON.stringify(controlIds))
  const controlBefore = await call('state'),
    controlSettings = await call('export-settings')
  let batchSettled = false,
    editSettled = false
  const controlledBatch = call('export-selection', '--format', 'original', '--output-dir', controlDirectory)
  controlledBatch.then(
    () => {
      batchSettled = true
    },
    () => {
      batchSettled = true
    }
  )
  let liveExport
  const controlDeadline = Date.now() + 30000
  while (Date.now() < controlDeadline) {
    liveExport = await call('export-status')
    if (
      liveExport?.status === 'running' &&
      liveExport.phase === 'writing' &&
      liveExport.current?.id === controlIds[1]
    )
      break
    assert.equal(batchSettled, false, 'Export must still be live while observing its generated chunk payload')
    await delay(10)
  }
  assert.equal(liveExport?.phase, 'writing')
  assert.equal(liveExport.current.id, controlIds[1])
  assert.equal(liveExport.completed, 1)
  const queuedControlEdit = call('edit', '--key', 'Exposure', '--value', '0.7')
  queuedControlEdit.then(
    () => {
      editSettled = true
    },
    () => {
      editSettled = true
    }
  )
  let liveCapture
  await watch(
    { session, observe: 'export-status', count: 1, images: path.join(root, 'export-live') },
    (update) => {
      liveCapture = update
    }
  )
  assert.ok(Number.isSafeInteger(liveCapture.revision))
  assert.equal(liveCapture.result.id, liveExport.id)
  assert.equal(liveCapture.result.status, 'running')
  assert.equal(liveCapture.result.completed, 1)
  assert.equal(editSettled, false, 'Ordinary editing stays serialized behind the live export')
  assert.equal((await readFile(liveCapture.frame.path)).subarray(1, 4).toString(), 'PNG')
  assert.equal(liveCapture.selected, controlBefore.selected)
  const requestedCancel = await call('export-cancel', '--id', liveExport.id)
  assert.equal(requestedCancel.id, liveExport.id)
  assert.ok(['cancelling', 'cancelled'].includes(requestedCancel.status))
  const cancelledBatch = await controlledBatch
  await queuedControlEdit
  assert.equal(cancelledBatch.cancelled, true)
  assert.equal(cancelledBatch.jobId, liveExport.id)
  assert.equal(cancelledBatch.files.length, 1)
  assert.deepEqual(await readFile(cancelledBatch.files[0].path), controlPng)
  assert.deepEqual(await readdir(controlDirectory), ['control-a.png'])
  const terminalExport = await call('export-status'),
    controlAfter = await call('state')
  assert.equal(terminalExport.status, 'cancelled')
  assert.equal(terminalExport.completed, 1)
  assert.equal((await call('export-cancel', '--id', liveExport.id)).status, 'cancelled')
  await assert.rejects(() => call('export-cancel', '--id', 'stale-export-id'), /not found/)
  assert.deepEqual(await call('export-settings'), controlSettings)
  assert.deepEqual(controlAfter.selection, controlBefore.selection)
  assert.equal(controlAfter.selected, controlBefore.selected)
  assert.equal(controlAfter.photos.find((photo) => photo.id === controlAfter.selected).edit.Exposure, 0.7)
  console.log(
    'Native export controls: actual live chunk progress and screenshot, queued edit isolation, cancellation, completed-file preservation, temporary cleanup and unchanged export settings passed.'
  )
  console.log(
    'Native GUI/CLI passed RAW, editing, PNG preview, original bytes, live observation, workspace capture, person segmentation, TIFF export and WebDAV sync.'
  )
} finally {
  host.kill()
  await Promise.race([exited, delay(3000)])
  await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
}
