// Generates small original JPEG XL validation fixtures and measures the actual
// native-FLOAT / working-FLOAT / legacy-byte boundaries of the pinned codec.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { jxlInputCases } from '../../tests/fixtures/jxl-input.mjs'
import { convertRgbColor, decodeSrgb } from '../../web/color-spaces.js'

const repository = new URL('../../', import.meta.url),
  fixtures = new URL('../../tests/fixtures/jxl/', import.meta.url),
  output = new URL('../../.workspace/jxl-input-color/', import.meta.url)
async function load(name) {
  const location = new URL(`../../.tools/codec-color/jxl/build/${name}.js`, import.meta.url)
  return (await import(location.href)).default({
    wasmBinary: await readFile(new URL(`${name}.wasm`, location))
  })
}
function range(data) {
  let minimum = Infinity,
    maximum = -Infinity
  for (let i = 0; i < data.length; i++)
    if (i % 4 !== 3) {
      minimum = Math.min(minimum, data[i])
      maximum = Math.max(maximum, data[i])
    }
  return { minimum, maximum }
}
function distinctRed(data) {
  return new Set(Array.from(data).filter((_, i) => i % 4 === 0)).size
}
function signature(profile) {
  return String.fromCharCode(...profile.subarray(16, 20))
}
function maxRgbError(a, b) {
  let maximum = 0
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) maximum = Math.max(maximum, Math.abs(a[i] - b[i]))
  return maximum
}

function encode(encoder, definition) {
  const input = new Uint8Array(definition.data.buffer, definition.data.byteOffset, definition.data.byteLength)
  return encoder.encodeFixture(input, definition.width, definition.height, definition.profile, {
    bitsPerSample: definition.bits,
    exponentBitsPerSample: definition.exponentBits,
    numColorChannels: definition.numColorChannels,
    alphaBits: definition.exponentBits ? 32 : 16,
    alphaExponentBits: definition.exponentBits ? 8 : 0,
    alphaPremultiplied: definition.premultiplied,
    usesOriginalProfile: definition.usesOriginalProfile,
    orientation: definition.orientation,
    structuredTransfer: definition.structuredTransfer,
    intensityTarget: [16, 18].includes(definition.structuredTransfer) ? 1000 : 255,
    lossless: definition.usesOriginalProfile
  })
}

function smallFloatRoundtripAblation(encoder, inspector, definitions) {
  const records = []
  for (const profile of ['table-float', 'linear-float', 'p3-float'])
    for (const width of [4, 8, 32]) {
      const data = Float32Array.from(
          Array.from({ length: width }, (_, x) => [-0.25 + x * 0.625, 0.5, 0.25, 1]).flat()
        ),
        bytes = encode(encoder, { ...definitions[profile], data, width, height: 1 }),
        native = inspector.inspectFloat(bytes)
      if (!native) throw Error('Small FLOAT ablation failed to decode')
      records.push({
        profile,
        width,
        maximumSourceError: maxRgbError(data, native.data),
        firstRed: Array.from(native.data)
          .filter((_, i) => i % 4 === 0)
          .slice(0, 8)
      })
    }
  return records
}

export async function runJxlInputColorExperiment({ generate = false } = {}) {
  const [encoder, inspector, decoder] = await Promise.all([
      generate ? load('jxl_input_fixture') : null,
      load('jxl_inspect'),
      load('jxl_color_dec')
    ]),
    definitions = jxlInputCases(),
    records = {},
    cmsCases = []
  await mkdir(output, { recursive: true })
  if (generate) await mkdir(fixtures, { recursive: true })
  for (const [name, definition] of [...Object.entries(definitions), ['animation-first', null]]) {
    let bytes
    if (generate) {
      if (definition) {
        bytes = encode(encoder, definition)
      } else bytes = encoder.encodeAnimationFixture()
      if (!bytes?.byteLength) throw Error('Fixture encoder failed: ' + name)
      await writeFile(new URL(`${name}.jxl`, fixtures), bytes)
    } else bytes = new Uint8Array(await readFile(new URL(`${name}.jxl`, fixtures)))
    const native = inspector.inspectFloat(bytes),
      working = decoder.decodeWorking(bytes),
      legacy = decoder.decode(bytes)
    if (!native || !working || !legacy) throw Error('Fixture decode failed: ' + name)
    const record = {
      filename: `${name}.jxl`,
      bytes: bytes.length,
      width: native.width,
      height: native.height,
      sourceBits: native.sourceBits,
      sourceExponentBits: native.sourceExponentBits,
      sourceAlphaPremultiplied: native.sourceAlphaPremultiplied,
      alphaBits: native.alphaBits,
      alphaExponentBits: native.alphaExponentBits,
      usesOriginalProfile: native.usesOriginalProfile,
      intensityTarget: native.intensityTarget,
      originalIccSpace: signature(native.originalICC),
      dataIccSpace: signature(native.dataICC),
      originalTransferFunction: native.originalTransferFunction,
      dataTransferFunction: native.dataTransferFunction,
      nativeRange: range(native.data),
      workingRange: range(working.data),
      workingColorSpace: working.colorSpace,
      profileTransform: working.profileTransform,
      profileCorrection: working.profileCorrection ?? null,
      compatibilityReason: working.compatibilityReason ?? null,
      nativeDistinctRed: distinctRed(native.data),
      workingDistinctRed: distinctRed(working.data),
      legacyDistinctRed: distinctRed(legacy.data),
      firstNative: Array.from(native.data.subarray(0, 12)),
      firstWorking: Array.from(working.data.subarray(0, 12)),
      firstLegacy: Array.from(legacy.data.subarray(0, 12))
    }
    if (
      definition &&
      definition.orientation === 1 &&
      definition.usesOriginalProfile &&
      !definition.premultiplied
    ) {
      const channels = definition.numColorChannels + 1,
        normalized = Float32Array.from(
          Array.from({ length: native.width * native.height }, (_, i) => {
            const values = Array.from(definition.data.subarray(i * channels, (i + 1) * channels), (v) =>
              definition.exponentBits ? v : v / 65535
            )
            return channels === 2 ? [values[0], values[0], values[0], values[1]] : values
          }).flat()
        )
      record.maxNativeSourceError = maxRgbError(native.data, normalized)
    }
    if (name === 'p3-float') {
      const expected = Float32Array.from(
        Array.from({ length: native.width * native.height }, (_, i) => [
          ...convertRgbColor(native.data.subarray(i * 4, i * 4 + 3), 'display-p3', 'srgb').map(decodeSrgb),
          native.data[i * 4 + 3]
        ]).flat()
      )
      record.maxSignedNamedSpaceError = maxRgbError(working.data, expected)
    }
    if (
      working.colorSpace === 'srgb-linear' &&
      (name === 'linear-float' || native.data.every((v, i) => i % 4 === 3 || (v >= 0 && v <= 1)))
    ) {
      cmsCases.push({
        name,
        intent: definition?.cmsIntent ?? (name.startsWith('lut') ? 0 : 1),
        profile: Array.from(native.dataICC),
        input: Array.from({ length: native.width * native.height }, (_, i) =>
          Array.from(native.data.subarray(i * 4, i * 4 + 3))
        ),
        expected: Array.from({ length: native.width * native.height }, (_, i) =>
          Array.from(working.data.subarray(i * 4, i * 4 + 3))
        )
      })
    }
    records[name] = record
  }
  const cms = spawnSync(
    process.env.OPENLR_CMS_PYTHON || 'python',
    [fileURLToPath(new URL('./jxl-input-cms.py', import.meta.url))],
    {
      cwd: fileURLToPath(repository),
      input: JSON.stringify({ cases: cmsCases }),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    }
  )
  if (cms.status !== 0) throw Error(cms.stderr || cms.stdout || String(cms.error))
  const report = {
    libjxlRevision: '9f544641ec83f6abd9da598bdd08178ee8a003e0',
    skcmsRevision: '64374756e03700d649f897dbd98c95e78c30c7da',
    records,
    independentCms: JSON.parse(cms.stdout)
  }
  for (const [name, record] of Object.entries(records)) {
    if (record.maxNativeSourceError !== undefined)
      assert.ok(record.maxNativeSourceError <= 6e-8, name + ': source precision')
    if (record.workingColorSpace === 'srgb-linear')
      assert.ok(
        Number.isFinite(record.workingRange.minimum) && Number.isFinite(record.workingRange.maximum),
        name + ': finite working samples'
      )
  }
  for (const [name, metrics] of Object.entries(report.independentCms.metrics))
    assert.ok(
      metrics.maxLinearSrgbError < 5e-4,
      name + ': independent CMS error ' + metrics.maxLinearSrgbError
    )
  for (const name of ['pq16', 'hlg16']) assert.equal(records[name].compatibilityReason, 'jxl-hdr-transfer')
  assert.equal(records['table-float'].compatibilityReason, 'jxl-profile-range')
  assert.equal(records['lut-mft1-16'].compatibilityReason, 'jxl-profile-unsupported')
  assert.equal(records['srgb16'].nativeDistinctRed, 512)
  assert.equal(records['srgb16'].workingDistinctRed, 512)
  assert.ok(records['srgb16'].legacyDistinctRed < 256)
  assert.equal(records['linear-float'].maxNativeSourceError, 0)
  assert.equal(records['p3-float'].maxNativeSourceError, 0)
  assert.ok(records['p3-float'].maxSignedNamedSpaceError < 0.001)
  assert.ok(records['p3-float'].workingRange.maximum > 2 && records['p3-float'].workingRange.minimum < 0)
  assert.equal(records['premul16'].sourceAlphaPremultiplied, true)
  assert.equal(records['premul16'].firstNative[0], 0.25)
  assert.equal(records['premul16'].firstNative[8], 1)
  report.checks =
    'Source precision, independent CMS error, signed color, true associated alpha, and explicit compatibility boundaries passed.'
  if (generate)
    report.smallFloatRoundtripAblation = smallFloatRoundtripAblation(encoder, inspector, definitions)
  await writeFile(new URL('results.json', output), JSON.stringify(report, null, 2) + '\n')
  if (generate)
    await writeFile(
      new URL('metadata.json', fixtures),
      JSON.stringify(
        {
          source:
            'Original OpenLR deterministic samples; see ../jxl-input.mjs and scripts/experiments/jxl-input-color.mjs',
          ...report
        },
        null,
        2
      ) + '\n'
    )
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runJxlInputColorExperiment({ generate: process.argv.includes('--generate') })
  console.log(JSON.stringify(report))
}
