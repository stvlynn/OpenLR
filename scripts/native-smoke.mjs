import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execute, parse, watch } from '../cli/openlr.mjs'
import { makeDng } from '../tests/fixtures/dng.mjs'
import { makeTiff } from '../tests/fixtures/tiff.mjs'
import { png as fixturePng } from '../tests/fixtures/merge-scene.js'
import UTIF from '../web/vendor/codecs/utif.js'
import { encodeColorTiff } from '../web/color-containers.js'
import { makeColorProfile } from '../web/color-spaces.js'
import { defaultOptions as avifOptions } from '../web/vendor/codecs/avif/meta.js'

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
  return sources
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
  console.log(
    'Native GUI/CLI passed RAW, editing, PNG preview, original bytes, live observation, workspace capture, person segmentation, TIFF export and WebDAV sync.'
  )
} finally {
  host.kill()
  await Promise.race([exited, delay(3000)])
  await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
}
