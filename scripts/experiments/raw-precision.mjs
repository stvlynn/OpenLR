// Original generated-sensor experiment; never uses photographs or proprietary profiles.
// Run: node scripts/experiments/raw-precision.mjs
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { serveWorkspace } from '../../tests/browser-server.mjs'
import { makeDng } from '../../tests/fixtures/dng.mjs'
import { convertRgbColor, makeColorProfile } from '../../web/color-spaces.js'

// Numeric transform in the shipped LibRaw revision's src/tables/colorconst.cpp.
// This is its sRGB -> "ProPhoto D65" transform, not standard ProPhoto D50.
const wideFromSrgb = [
  0.529317, 0.330092, 0.140588, 0.098368, 0.873465, 0.028169, 0.016879, 0.117663, 0.865457
]
function inverse(m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const cofactor = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d
  ]
  const determinant = a * cofactor[0] + b * cofactor[3] + c * cofactor[6]
  return cofactor.map((value) => value / determinant)
}
const srgbFromWide = inverse(wideFromSrgb)
const mul = (matrix, v) =>
  [0, 1, 2].map((row) => matrix[row * 3] * v[0] + matrix[row * 3 + 1] * v[1] + matrix[row * 3 + 2] * v[2])
const srgbEncode = (value) => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055)
const srgbDecode = (value) =>
  Math.abs(value) <= 0.04045 ? value / 12.92 : Math.sign(value) * ((Math.abs(value) + 0.055) / 1.055) ** 2.4
const prophotoEncode = (value) => (value <= 1 / 512 ? 16 * value : value ** (1 / 1.8))

function sensorFixture(kind) {
  const width = kind === 'ramp' ? 4096 : 512,
    height = 64
  const bytes = makeDng({ width, height })
  const view = new DataView(bytes.buffer)
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
      const value =
        kind === 'ramp'
          ? 0.02 + (0.78 * Math.floor(x / 2)) / (width / 2 - 1)
          : patches[Math.floor(x / 64)][channel]
      view.setUint16(strip + 2 * (y * width + x), 256 + Math.round(3839 * value), true)
    }
  return { name: kind, width, height, bytes }
}

const server = await serveWorkspace()
let browser
try {
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  const page = await browser.newPage()
  await page.goto(server.url)
  const facts = {
    node: process.version,
    platform: process.platform,
    browser: browser.version(),
    fixtures: {}
  }
  const modes = [
    { name: 'srgb8DefaultGamma', color: 1, bits: 8 },
    { name: 'srgb16Linear', color: 1, bits: 16, linear: true },
    { name: 'librawProPhotoD65_16Linear', color: 4, bits: 16, linear: true }
  ]
  for (const kind of ['ramp', 'patches']) {
    const fixture = sensorFixture(kind)
    const before = fixture.bytes.slice()
    const results = await page.evaluate(
      async ({ bytes, modes }) => {
        const { LibRaw } = await import('./vendor/libraw/index.js')
        await LibRaw.initialize()
        const outputs = []
        for (const mode of modes) {
          const decoder = new LibRaw()
          await decoder.waitUntilReady()
          try {
            decoder.open(new Uint8Array(bytes).buffer)
            decoder.setHalfSize(0)
            decoder.setUseCameraWb(1)
            decoder.setOutputColor(mode.color)
            decoder.setOutputBps(mode.bits)
            if (mode.linear) {
              decoder.setGamma(0, 1)
              decoder.setGamma(1, 1)
            }
            decoder.setNoAutoBright(1)
            decoder.setBright(1)
            const start = performance.now()
            decoder.unpack()
            decoder.dcrawProcess()
            const image = decoder.dcrawMakeMemImage()
            const elapsedMs = performance.now() - start
            const view = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength)
            const pixels = Array.from({ length: image.width * image.height * image.colors }, (_, n) =>
              mode.bits === 16 ? view.getUint16(n * 2, true) : image.data[n]
            )
            outputs.push({
              mode: mode.name,
              width: image.width,
              height: image.height,
              colors: image.colors,
              bits: image.bits,
              elapsedMs,
              pixels
            })
          } finally {
            decoder.dispose()
          }
        }
        return { version: LibRaw.version(), outputs }
      },
      { bytes: Array.from(fixture.bytes), modes }
    )
    assert.deepEqual(fixture.bytes, before)
    facts.libraw = results.version
    const summarized = { inputDimensions: [fixture.width, fixture.height], inputUnchanged: true, modes: {} }
    for (const output of results.outputs) {
      assert.equal(output.width, fixture.width)
      assert.equal(output.height, fixture.height)
      assert.equal(output.colors, 3)
      const y = Math.floor(output.height / 2)
      const row = output.pixels.slice(y * output.width * 3, (y + 1) * output.width * 3)
      const region = row.slice(24, row.length - 24)
      const sets = [new Set(), new Set(), new Set()]
      for (let n = 0; n < region.length; n++) sets[n % 3].add(region[n])
      summarized.modes[output.mode] = {
        dimensions: [output.width, output.height],
        bits: output.bits,
        distinctCentralRow: sets.map((set) => set.size),
        rowMin: [0, 1, 2].map((c) => Math.min(...region.filter((_, n) => n % 3 === c))),
        rowMax: [0, 1, 2].map((c) => Math.max(...region.filter((_, n) => n % 3 === c))),
        nonMultiple257Samples: output.bits === 16 ? region.filter((v) => v % 257 !== 0).length : null,
        elapsedMs: output.elapsedMs
      }
    }
    const wide = results.outputs[2],
      narrow = results.outputs[1],
      encoded8 = results.outputs[0]
    if (kind === 'ramp') {
      let maximumAbsoluteCodeDifference = 0,
        absoluteCodeDifferenceSum = 0,
        signedCodeDifferenceSum = 0,
        sampleCount = 0,
        differentSamples = 0
      const explicitLevels = [new Set(), new Set(), new Set()]
      const y = Math.floor(narrow.height / 2)
      for (let x = 8; x < narrow.width - 8; x++) {
        for (let c = 0; c < 3; c++) {
          const offset = (y * narrow.width + x) * 3 + c
          const explicitCode = Math.round(255 * srgbEncode(narrow.pixels[offset] / 65535))
          const difference = explicitCode - encoded8.pixels[offset]
          explicitLevels[c].add(explicitCode)
          maximumAbsoluteCodeDifference = Math.max(maximumAbsoluteCodeDifference, Math.abs(difference))
          absoluteCodeDifferenceSum += Math.abs(difference)
          signedCodeDifferenceSum += difference
          sampleCount++
          if (difference) differentSamples++
        }
      }
      summarized.defaultGammaVersusExplicitSrgb = {
        sampleCount,
        differentSamples,
        maximumAbsoluteCodeDifference,
        meanAbsoluteCodeDifference: absoluteCodeDifferenceSum / sampleCount,
        meanExplicitMinusDefault: signedCodeDifferenceSum / sampleCount,
        explicitSrgbDistinctLevels: explicitLevels.map((set) => set.size)
      }
    }
    let outside = 0,
      wideInterior = 0,
      outsideWithWideInterior = 0,
      narrowBoundary = 0,
      comparable = 0,
      maximumInteriorError = 0
    let minSrgb = [Infinity, Infinity, Infinity],
      maxSrgb = [-Infinity, -Infinity, -Infinity]
    for (let y = 8; y < wide.height - 8; y++)
      for (let x = 8; x < wide.width - 8; x++) {
        const offset = (y * wide.width + x) * 3
        const wideRgb = wide.pixels.slice(offset, offset + 3).map((v) => v / 65535)
        const linearSrgb = mul(srgbFromWide, wideRgb)
        const interior = wideRgb.every((v) => v > 2 / 65535 && v < 1 - 2 / 65535)
        if (interior) wideInterior++
        if (linearSrgb.some((v) => v < -4 / 65535 || v > 1 + 4 / 65535)) {
          outside++
          if (interior) outsideWithWideInterior++
        }
        if (narrow.pixels.slice(offset, offset + 3).some((v) => v === 0 || v === 65535)) narrowBoundary++
        if (interior && linearSrgb.every((v) => v > 0 && v < 1)) {
          comparable++
          for (let c = 0; c < 3; c++)
            maximumInteriorError = Math.max(
              maximumInteriorError,
              Math.abs(linearSrgb[c] - narrow.pixels[offset + c] / 65535)
            )
        }
        linearSrgb.forEach((v, c) => {
          minSrgb[c] = Math.min(minSrgb[c], v)
          maxSrgb[c] = Math.max(maxSrgb[c], v)
        })
      }
    summarized.gamut = {
      interiorPixels: (wide.width - 16) * (wide.height - 16),
      wideInterior,
      outsideSrgb: outside,
      outsideWithWideInterior,
      srgb16BoundaryPixels: narrowBoundary,
      minSrgb,
      maxSrgb,
      comparable,
      maximumInteriorError,
      maximumInteriorErrorIn16bitLevels: maximumInteriorError * 65535
    }
    if (kind === 'patches') {
      summarized.patchCenters = Array.from({ length: 8 }, (_, patch) => {
        const offset = (32 * wide.width + patch * 64 + 32) * 3
        const linearWide = wide.pixels.slice(offset, offset + 3).map((v) => v / 65535)
        const actualSrgb = mul(srgbFromWide, linearWide)
        const standardInterpretation = convertRgbColor(
          linearWide.map(prophotoEncode),
          'prophoto-rgb',
          'srgb'
        ).map(srgbDecode)
        return {
          patch,
          srgb8: encoded8.pixels.slice(offset, offset + 3),
          srgb16: narrow.pixels.slice(offset, offset + 3),
          wide16: wide.pixels.slice(offset, offset + 3),
          reconstructedLinearSrgb: actualSrgb,
          wideHasBoundarySample: linearWide.some((v) => v === 0 || v === 1),
          standardProPhotoApproximationMaxLinearError: Math.max(
            ...actualSrgb.map((v, c) => Math.abs(v - standardInterpretation[c]))
          )
        }
      })
      assert.ok(outside > 0, 'Fixture must demonstrate actual colors outside sRGB')
    } else {
      assert.ok(
        summarized.modes.srgb16Linear.distinctCentralRow[0] >
          summarized.modes.srgb8DefaultGamma.distinctCentralRow[0]
      )
      assert.ok(summarized.modes.librawProPhotoD65_16Linear.nonMultiple257Samples > 0)
    }
    facts.fixtures[kind] = summarized
  }
  const librawD50FromSrgb = [
    0.436083, 0.385083, 0.143055, 0.222507, 0.716888, 0.060608, 0.01393, 0.097097, 0.714022
  ]
  const exactPcsFromWide = [0, 1, 2].flatMap((row) =>
    [0, 1, 2].map((col) =>
      [0, 1, 2].reduce((sum, k) => sum + librawD50FromSrgb[row * 3 + k] * srgbFromWide[k * 3 + col], 0)
    )
  )
  const profile = makeColorProfile('prophoto-rgb')
  const pv = new DataView(profile.buffer, profile.byteOffset, profile.byteLength)
  const standardPcs = Array(9).fill(0)
  for (let n = 0; n < pv.getUint32(128); n++) {
    const at = 132 + n * 12,
      tag = String.fromCharCode(...profile.slice(at, at + 4))
    const col = ['rXYZ', 'gXYZ', 'bXYZ'].indexOf(tag)
    if (col < 0) continue
    const offset = pv.getUint32(at + 4)
    for (let row = 0; row < 3; row++) standardPcs[row * 3 + col] = pv.getInt32(offset + 8 + row * 4) / 65536
  }
  facts.colorContract = {
    wideFromSrgb,
    srgbFromWide,
    exactPcsFromWide,
    standardProPhotoProfilePcs: standardPcs,
    maxPcsColorantDifference: Math.max(...exactPcsFromWide.map((v, n) => Math.abs(v - standardPcs[n]))),
    exactPcsWhite: mul(exactPcsFromWide, [1, 1, 1])
  }
  const output = new URL('../../.workspace/raw-precision/', import.meta.url)
  await mkdir(output, { recursive: true })
  await writeFile(new URL('results.json', output), JSON.stringify(facts, null, 2) + '\n')
  console.log(JSON.stringify(facts, null, 2))
} finally {
  await browser?.close()
  server.close()
}
