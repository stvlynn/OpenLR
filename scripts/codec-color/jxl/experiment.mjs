import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { convertSrgbPixels, makeColorProfile } from '../../../web/color-spaces.js'

const directory = resolve(process.argv[2] || '.tools/codec-color/jxl/build')
const output = resolve(process.argv[3] || '.tools/codec-color/jxl/experiment')
await mkdir(output, { recursive: true })
async function initialize(name) {
  const { default: factory } = await import(pathToFileURL(resolve(directory, name + '.js')))
  return factory({ wasmBinary: await readFile(resolve(directory, name + '.wasm')) })
}
const encoder = await initialize('jxl_color_enc')
assert.equal(typeof encoder.encodeColorExperiment, 'function',
  'Build with OPENLR_JXL_EXPERIMENTS=ON to expose test-only mode control')
const inspector = await initialize('jxl_inspect')
const width = 256, height = 192
const source = { width, height, data: new Uint8ClampedArray(width * height * 4) }
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const offset = (y * width + x) * 4
  source.data.set([x, Math.round(y * 255 / (height - 1)),
    (x * 37 + y * 13) % 256, (x + y) % 256], offset)
}
await writeFile(resolve(output, 'source.rgba'), source.data)
await writeFile(resolve(output, 'source.icc'), makeColorProfile('srgb'))
const results = []
for (const space of ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020']) {
  const target = convertSrgbPixels(source, space), profile = makeColorProfile(space)
  for (const quality of [100, 80]) for (const modular of [false, true]) {
    const start = performance.now()
    const encoded = encoder.encodeColorExperiment(target.data, width, height, profile,
      quality, quality === 100, 7, false, modular)
    const milliseconds = performance.now() - start
    assert(encoded, `${space}/${quality}/${modular} encoding failed`)
    const decoded = inspector.inspect(encoded)
    assert(decoded, 'Real codestream decoding failed')
    assert.equal(decoded.width, width)
    assert.equal(decoded.height, height)
    assert.equal(decoded.bitsPerSample, 8)
    assert.equal(decoded.alphaBits, 8)
    assert(decoded.usesOriginalProfile, 'Target samples must use the target ICC')
    let maxRGB = 0, maxAlpha = 0, sumRGB = 0
    for (let i = 0; i < target.data.length; i++) {
      const error = Math.abs(target.data[i] - decoded.pixels[i])
      if (i % 4 === 3) maxAlpha = Math.max(maxAlpha, error)
      else { maxRGB = Math.max(maxRGB, error); sumRGB += error }
    }
    if (quality === 100) {
      assert.equal(maxRGB, 0, 'Lossless target samples must be byte exact')
      assert.equal(maxAlpha, 0, 'Lossless alpha must remain byte exact')
    }
    // ICC may be internally represented as structured color fields by libjxl.
    const originalExact = Buffer.from(decoded.originalICC).equals(Buffer.from(profile))
    const dataExact = Buffer.from(decoded.dataICC).equals(Buffer.from(profile))
    const stem = `${space}-${quality}-${modular ? 'modular' : 'vardct'}`
    await writeFile(resolve(output, stem + '.jxl'), encoded)
    await writeFile(resolve(output, stem + '.icc'), decoded.dataICC)
    await writeFile(resolve(output, stem + '.rgba'), decoded.pixels)
    results.push({ space, quality, modular, bytes: encoded.length,
      milliseconds: +milliseconds.toFixed(2), maxRGB, meanRGB: sumRGB / (width * height * 3),
      maxAlpha, originalICCBytes: decoded.originalICC.length,
      dataICCBytes: decoded.dataICC.length, originalExact, dataExact })
  }
}
assert.equal(encoder.encodeColor(source.data, width, height, new Uint8Array([1, 2, 3]),
  100, true, 7, true), null, 'Malformed ICC must fail')
assert.equal(inspector.inspect(new Uint8Array([1, 2, 3])), null, 'Corrupt JXL must fail')
for (const modular of [false, true]) {
  assert(encoder.encodeColorExperiment(source.data, width, height, makeColorProfile('srgb'),
    0, false, 7, false, modular), 'The quality=0 endpoint must encode')
}
await writeFile(resolve(output, 'results.json'), JSON.stringify({ width, height, results }, null, 2) + '\n')
console.log(JSON.stringify({ width, height, results }, null, 2))
