import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makeDng } from './fixtures/dng.mjs'

// The generated sensor stress cases from research/high-precision-raw.md.
// Identity camera calibration is deliberate; this is not a physical camera.
function sensorFixture(ramp) {
  const width = ramp ? 4096 : 512,
    height = 64,
    bytes = makeDng({ width, height }),
    view = new DataView(bytes.buffer)
  let strip
  for (let n = 0; n < view.getUint16(8, true); n++) {
    const entry = 10 + n * 12
    if (view.getUint16(entry, true) === 273) strip = view.getUint32(entry + 8, true)
  }
  const patches = [
    [0.7, 0.06, 0.06],
    [0.06, 0.7, 0.06],
    [0.06, 0.06, 0.7],
    [0.15, 0.5, 0.12],
    [0.4, 0.2, 0.05],
    [0.15, 0.25, 0.6],
    [0.18, 0.18, 0.18],
    [0.9, 0.9, 0.9]
  ]
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const channel = y % 2 === 0 ? (x % 2 === 0 ? 0 : 1) : x % 2 === 0 ? 1 : 2
      const value = ramp
        ? 0.02 + (0.78 * Math.floor(x / 2)) / (width / 2 - 1)
        : patches[Math.floor(x / 64)][channel]
      view.setUint16(strip + 2 * (y * width + x), 256 + Math.round(3839 * value), true)
    }
  return Array.from(bytes)
}

test('real LibRaw working decode keeps wide signed colors and sensor precision through worker and fallback', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(
    async ({ patches, ramp, rotated }) => {
      const { decodeRaw } = await import('./raw-kernel.js'),
        { runImageWorker, getImageWorkerDiagnostics } = await import('./image-worker.js'),
        { LibRaw } = await import('./vendor/libraw/index.js')
      const makeFile = (bytes) => new File([new Uint8Array(bytes)], 'generated.dng')
      const decode = async (file) =>
        (
          await runImageWorker(
            new URL('./decode-worker.js', location.href),
            { file, working: true },
            [],
            async ({ file }) => ({ frame: await decodeRaw(file, { working: true }) })
          )
        ).frame
      const file = makeFile(patches),
        working = await decode(file),
        legacy = await decodeRaw(file, { linear: true })
      // Read the actual wide integer decoder boundary independently. Multiplying
      // working RGB by the forward W tests the inverse without copying its code.
      await LibRaw.initialize()
      const reference = new LibRaw()
      await reference.waitUntilReady()
      let wide
      try {
        reference.open(await file.arrayBuffer())
        reference.setHalfSize(0)
        reference.setUseCameraWb(1)
        reference.setOutputColor(4)
        reference.setOutputBps(16)
        reference.setGamma(0, 1)
        reference.setGamma(1, 1)
        reference.setNoAutoBright(1)
        reference.setBright(1)
        reference.unpack()
        reference.dcrawProcess()
        const image = reference.dcrawMakeMemImage()
        const view = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength)
        wide = Uint16Array.from({ length: image.width * image.height * 3 }, (_, i) =>
          view.getUint16(i * 2, true)
        )
      } finally {
        reference.dispose()
      }
      const W = [0.529317, 0.330092, 0.140588, 0.098368, 0.873465, 0.028169, 0.016879, 0.117663, 0.865457]
      let maximumForwardError = 0,
        negativeInterior = 0,
        maximum = -Infinity,
        finite = true,
        opaque = true
      for (let i = 0, n = 0; i < working.data.length; i += 4, n += 3) {
        const r = working.data[i],
          g = working.data[i + 1],
          b = working.data[i + 2]
        for (let c = 0; c < 3; c++) {
          const row = c * 3,
            reconstructed = W[row] * r + W[row + 1] * g + W[row + 2] * b
          maximumForwardError = Math.max(maximumForwardError, Math.abs(reconstructed - wide[n + c] / 65535))
          maximum = Math.max(maximum, working.data[i + c])
          finite &&= Number.isFinite(working.data[i + c])
        }
        opaque &&= working.data[i + 3] === 1
        if (Math.min(r, g, b) < -4 / 65535 && wide.slice(n, n + 3).every((v) => v > 2 && v < 65533))
          negativeInterior++
      }
      const center = (patch) => 32 * working.width + patch * 64 + 32
      const retained = [3, 5].map((patch) => ({
        working: Array.from(working.data.slice(center(patch) * 4, center(patch) * 4 + 3)),
        legacy: Array.from(legacy.linear.slice(center(patch) * 3, center(patch) * 3 + 3)),
        wide: Array.from(wide.slice(center(patch) * 3, center(patch) * 3 + 3))
      }))
      const rampFrame = await decode(makeFile(ramp)),
        distinct = [new Set(), new Set(), new Set()],
        byteGroups = new Map()
      let byteCollision = false
      for (let x = 8; x < rampFrame.width - 8; x++)
        for (let c = 0; c < 3; c++) {
          const value = rampFrame.data[(32 * rampFrame.width + x) * 4 + c]
          distinct[c].add(value)
          if (c === 0 && value > 0 && value < 1) {
            const byte = Math.round(
              255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055)
            )
            if (byteGroups.has(byte) && byteGroups.get(byte) !== value) byteCollision = true
            byteGroups.set(byte, value)
          }
        }
      const oriented = await decode(makeFile(rotated))
      let failureCode
      try {
        await decode(new File(['invalid'], 'invalid.dng'))
      } catch (error) {
        failureCode = error.code
      }
      const recovered = await decode(file)
      const NativeWorker = window.Worker
      let fallback
      try {
        window.Worker = class {
          constructor() {
            throw new Error('Forced working RAW worker startup failure')
          }
        }
        fallback = await decode(file)
      } finally {
        window.Worker = NativeWorker
      }
      let fallbackDifference = 0,
        recoveryDifference = 0
      for (let i = 0; i < working.data.length; i++) {
        fallbackDifference = Math.max(fallbackDifference, Math.abs(fallback.data[i] - working.data[i]))
        recoveryDifference = Math.max(recoveryDifference, Math.abs(recovered.data[i] - working.data[i]))
      }
      return {
        dimensions: [working.width, working.height],
        type: working.data.constructor.name,
        colorSpace: working.colorSpace,
        provenance: working.provenance,
        maximumForwardError,
        negativeInterior,
        maximum,
        finite,
        opaque,
        retained,
        distinct: distinct.map((set) => set.size),
        byteCollision,
        oriented: [oriented.width, oriented.height],
        failureCode,
        fallbackDifference,
        recoveryDifference,
        fallbackDiagnostic: getImageWorkerDiagnostics().at(-1),
        unchanged: Array.from(new Uint8Array(await file.arrayBuffer())).every((v, i) => v === patches[i]),
        legacyLayout: legacy.linear instanceof Float32Array && legacy.data instanceof Uint8ClampedArray
      }
    },
    {
      patches: sensorFixture(false),
      ramp: sensorFixture(true),
      rotated: Array.from(makeDng({ orientation: 6 }))
    }
  )
  assert.deepEqual(result.dimensions, [512, 64])
  assert.equal(result.type, 'Float32Array')
  assert.equal(result.colorSpace, 'srgb-linear')
  assert.equal(result.provenance.outputColor, 4)
  assert.equal(result.provenance.outputBits, 16)
  assert.equal(result.provenance.precision, 'uint16-processed')
  assert.ok(result.maximumForwardError < 2e-7, JSON.stringify(result))
  assert.ok(result.negativeInterior > 1000)
  assert.ok(result.maximum > 1)
  assert.equal(result.finite, true)
  assert.equal(result.opaque, true)
  for (const patch of result.retained) {
    assert.ok(patch.working[0] < -0.2)
    assert.equal(patch.legacy[0], 0)
    assert.ok(patch.wide.every((v) => v > 0 && v < 65535))
  }
  assert.ok(
    result.distinct.every((n) => n > 1000),
    JSON.stringify(result.distinct)
  )
  assert.equal(result.byteCollision, true)
  assert.deepEqual(result.oriented, [96, 128])
  assert.equal(result.failureCode, 'RAW_DECODE')
  assert.equal(result.fallbackDifference, 0)
  assert.equal(result.recoveryDifference, 0)
  assert.equal(result.fallbackDiagnostic.worker, 'decode-worker.js')
  assert.equal(result.fallbackDiagnostic.fallback, 'main-thread')
  assert.equal(result.unchanged, true)
  assert.equal(result.legacyLayout, true)
  console.log('Float RAW decode facts:', JSON.stringify(result))
})

test('shared decode/render/export APIs recover RAW highlights and preserve signed gamut in real ProPhoto TIFF16 samples', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(
    async ({ patches, ramp }) => {
      const { decodePhotoFrame } = await import('./decode.js'),
        { renderFrame, frameCanvas } = await import('./render.js'),
        { encodeFrameTiff } = await import('./encode.js'),
        { validateLocalTool } = await import('./local-tools.js')
      const edit = {
        Exposure: -4,
        localTools: {
          masks: [
            validateLocalTool('mask', {
              type: 'radial',
              center: { x: 0.5, y: 0.5 },
              rx: 1,
              ry: 1,
              feather: 0,
              adjustments: { Exposure: 4 }
            })
          ]
        }
      }
      // This reader interprets the serialized TIFF strips and ICC independently;
      // it never calls the writer, image decoder or an RGBA8 convenience method.
      async function readTiff(blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer()),
          view = new DataView(bytes.buffer),
          tags = new Map()
        if (view.getUint16(0, true) !== 0x4949 || view.getUint16(2, true) !== 42)
          throw Error('Expected classic little-endian TIFF')
        const ifd = view.getUint32(4, true)
        for (let n = 0; n < view.getUint16(ifd, true); n++) {
          const at = ifd + 2 + n * 12,
            id = view.getUint16(at, true),
            type = view.getUint16(at + 2, true),
            count = view.getUint32(at + 4, true)
          const size = type === 3 ? 2 : type === 4 ? 4 : 1,
            offset = count * size <= 4 ? at + 8 : view.getUint32(at + 8, true)
          const values = Array.from({ length: count }, (_, i) =>
            size === 2
              ? view.getUint16(offset + i * 2, true)
              : size === 4
                ? view.getUint32(offset + i * 4, true)
                : bytes[offset + i]
          )
          tags.set(id, values)
        }
        const values = []
        tags.get(273).forEach((offset, n) => {
          for (let at = offset; at < offset + tags.get(279)[n]; at += 2) values.push(view.getUint16(at, true))
        })
        const profile = Uint8Array.from(tags.get(34675)),
          pv = new DataView(profile.buffer),
          columns = []
        for (let n = 0; n < pv.getUint32(128); n++) {
          const at = 132 + n * 12,
            signature = String.fromCharCode(...profile.slice(at, at + 4)),
            col = ['rXYZ', 'gXYZ', 'bXYZ'].indexOf(signature)
          if (col < 0) continue
          const offset = pv.getUint32(at + 4)
          columns[col] = [0, 1, 2].map((c) => pv.getInt32(offset + 8 + c * 4) / 65536)
        }
        return { tags, values, columns }
      }
      const source = await decodePhotoFrame(new File([new Uint8Array(patches)], 'patches.dng')),
        original = source.data.slice(),
        edited = renderFrame(source, edit),
        view = frameCanvas(edited),
        output = await readTiff(await encodeFrameTiff(edited, 'prophoto-rgb'))
      let recoveryError = 0,
        unchanged = true
      for (let i = 0; i < source.data.length; i++) {
        recoveryError = Math.max(recoveryError, Math.abs(edited.data[i] - original[i]))
        unchanged &&= source.data[i] === original[i]
      }
      // Published D50 XYZ -> linear sRGB matrix; ICC colorants supply the actual
      // exported ProPhoto definition. This does not reuse OpenLR color helpers.
      const srgbFromD50 = [
        3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914, 1.4052427
      ]
      const decoded = [3, 5].map((patch) => {
        const index = (32 * source.width + patch * 64 + 32) * 4,
          encoded = output.values.slice(index, index + 3).map((v) => v / 65535),
          linear = encoded.map((v) => (v <= 1 / 32 ? v / 16 : v ** 1.8)),
          xyz = [0, 1, 2].map((row) => linear.reduce((sum, v, c) => sum + v * output.columns[c][row], 0)),
          recovered = [0, 1, 2].map((row) =>
            xyz.reduce((sum, v, c) => sum + v * srgbFromD50[row * 3 + c], 0)
          ),
          expected = Array.from(original.slice(index, index + 3))
        return {
          encoded,
          recovered,
          expected,
          error: Math.max(...expected.map((v, c) => Math.abs(v - recovered[c])))
        }
      })
      const rampSource = await decodePhotoFrame(new File([new Uint8Array(ramp)], 'ramp.dng')),
        rampEdited = renderFrame(rampSource, edit),
        rampTiff = await readTiff(await encodeFrameTiff(rampEdited, 'prophoto-rgb')),
        distinct = [new Set(), new Set(), new Set()]
      let lowBits = 0,
        alpha = true
      for (let x = 8; x < rampEdited.width - 8; x++) {
        const index = (32 * rampEdited.width + x) * 4
        for (let c = 0; c < 3; c++) {
          const value = rampTiff.values[index + c]
          distinct[c].add(value)
          if (value % 257) lowBits++
        }
        alpha &&= rampTiff.values[index + 3] === 65535
      }
      return {
        recoveryError,
        unchanged,
        decoded,
        dimensions: [view.width, view.height],
        bits: output.tags.get(258),
        alphaTag: output.tags.get(338),
        lowBits,
        distinct: distinct.map((s) => s.size),
        alpha,
        profileColumns: output.columns
      }
    },
    { patches: sensorFixture(false), ramp: sensorFixture(true) }
  )
  assert.ok(result.recoveryError < 5e-7, JSON.stringify(result))
  assert.equal(result.unchanged, true)
  assert.deepEqual(result.dimensions, [512, 64])
  assert.deepEqual(result.bits, [16, 16, 16, 16])
  assert.deepEqual(result.alphaTag, [2])
  for (const patch of result.decoded) {
    assert.ok(patch.recovered[0] < -0.2)
    assert.ok(patch.error < 3e-4, JSON.stringify(patch))
    assert.ok(patch.encoded.every((v) => v > 0 && v < 1))
  }
  assert.ok(result.lowBits > 1000)
  assert.ok(
    result.distinct.every((n) => n > 1000),
    JSON.stringify(result)
  )
  assert.equal(result.alpha, true)
  console.log('RAW shared float pipeline facts:', JSON.stringify(result))
})
