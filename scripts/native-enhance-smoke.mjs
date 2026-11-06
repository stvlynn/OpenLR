import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execute, parse } from '../cli/openlr.mjs'
import { makePng } from '../tests/fixtures/png.mjs'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const portrait = new URL('../tests/fixtures/ai/astronaut.png', import.meta.url)
const models = JSON.parse(await readFile(new URL('../research/enhance/models.json', import.meta.url), 'utf8'))

function decode(bytes) {
  const { width, height, data, sourceBits } = readPng(bytes)
  assert.equal(sourceBits, 8)
  return { width, height, pixels: Uint8Array.from(data, (value) => Math.round(value * 255)) }
}

function noisyCrop(portraitBytes) {
  const { width, height, pixels } = decode(portraitBytes)
  assert.deepEqual([width, height], [512, 512])
  const size = 96,
    clean = new Uint8ClampedArray(size * size * 3)
  // Average 2×2 source samples across the same portrait region as the browser test.
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const topLeft = ((40 + 2 * y) * width + 160 + 2 * x) * 4
      for (let c = 0; c < 3; c++)
        clean[(y * size + x) * 3 + c] =
          (pixels[topLeft + c] +
            pixels[topLeft + c + 4] +
            pixels[topLeft + c + width * 4] +
            pixels[topLeft + c + width * 4 + 4]) /
          4
    }
  let seed = 42
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) + 0.5) / 4294967296
  const noise = () => 15 * Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random())
  const noisy = Uint8ClampedArray.from(clean, (value) => value + noise())
  return { clean, size, bytes: makePng({ width: size, height: size, bits: 8, srgb: 0, data: noisy }) }
}

function mseAgainstClean({ pixels }, clean) {
  assert.equal((pixels.length / 4) * 3, clean.length)
  let error = 0
  for (let pixel = 0; pixel < pixels.length / 4; pixel++) {
    const offset = pixel * 4
    assert.equal(pixels[offset + 3], 255)
    for (let channel = 0; channel < 3; channel++)
      error += (pixels[offset + channel] - clean[pixel * 3 + channel]) ** 2
  }
  return error / clean.length
}

function bilinearAt({ width, height, pixels }, x, y) {
  const u = Math.min(width - 1, Math.max(0, x)),
    v = Math.min(height - 1, Math.max(0, y))
  const left = Math.floor(u),
    top = Math.floor(v),
    right = Math.min(width - 1, left + 1),
    bottom = Math.min(height - 1, top + 1)
  return Array.from({ length: 4 }, (_, channel) => {
    const read = (px, py) => pixels[(py * width + px) * 4 + channel]
    const upper = read(left, top) * (1 - u + left) + read(right, top) * (u - left),
      lower = read(left, bottom) * (1 - u + left) + read(right, bottom) * (u - left)
    return upper * (1 - v + top) + lower * (v - top)
  })
}

function checkLearnedLuma(output, input) {
  const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b
  let changed = 0,
    chromaControls = 0,
    maxChromaError = 0,
    lumaDelta = 0
  for (let y = 0; y < output.height; y++)
    for (let x = 0; x < output.width; x++) {
      const offset = (y * output.width + x) * 4,
        pixels = output.pixels.subarray(offset, offset + 4),
        base = bilinearAt(input, (x + 0.5) / 3 - 0.5, (y + 0.5) / 3 - 0.5)
      assert.equal(pixels[3], Math.round(base[3]))
      const delta = Math.abs(luma(pixels) - luma(base))
      if (delta > 2) changed++
      lumaDelta += delta
      if (
        pixels[0] > 0 &&
        pixels[0] < 255 &&
        pixels[1] > 0 &&
        pixels[1] < 255 &&
        pixels[2] > 0 &&
        pixels[2] < 255
      ) {
        maxChromaError = Math.max(
          maxChromaError,
          Math.abs(pixels[0] - pixels[1] - (base[0] - base[1])),
          Math.abs(pixels[2] - pixels[1] - (base[2] - base[1]))
        )
        chromaControls++
      }
    }
  const area = output.width * output.height,
    meanAbsoluteLumaDelta = lumaDelta / area
  assert.ok(
    changed > area / 4 && meanAbsoluteLumaDelta > 1,
    'Learned luminance should differ from interpolation'
  )
  assert.ok(chromaControls > area / 3)
  assert.ok(maxChromaError <= 1.01, `Unclipped chroma exceeded byte rounding: ${maxChromaError}`)
  return { changed, chromaControls, meanAbsoluteLumaDelta, maxChromaError }
}

await withNativeWorkspace(process.argv[2], async ({ root, call, initial, session }) => {
  assert.deepEqual(initial.photos, [])
  const original = await readFile(portrait),
    { clean, size, bytes } = noisyCrop(original),
    file = path.join(root, 'noisy-portrait.png')
  await writeFile(file, bytes)
  const imported = await call('import', file)
  assert.deepEqual(imported.failed, [])
  assert.equal(imported.added.length, 1)
  const sourceId = imported.added[0]
  const selectSource = () => call('select', '--id', sourceId)
  const exportBytes = async (name, format = 'original') => {
    const saved = await call('export', '--format', format, '--output', path.join(root, name))
    return readFile(saved.path)
  }
  async function enhance(mode, modelId, sourceEdit, dimensions, name) {
    console.log('Native enhancement first-use runtime fetch: ' + mode)
    // Keep the longer deadline on the first-use model command. A failed or
    // timed-out creation is surfaced without issuing another mutation.
    const result = await execute(
      parse([
        'enhance',
        '--mode',
        mode,
        '--strength',
        '1',
        '--photoId',
        sourceId,
        '--session',
        session,
        '--timeout',
        '150'
      ])
    )
    const state = await call('state'),
      derived = state.photos.find(({ id }) => id === result.id)
    assert.notEqual(result.id, sourceId)
    assert.equal(state.selected, result.id)
    assert.equal(result.name, name)
    assert.equal(derived.name, name)
    assert.equal(derived.mediaType, 'image/png')
    assert.deepEqual(derived.edit, {})
    assert.deepEqual(derived.enhance, result.enhance)
    assert.deepEqual([result.width, result.height], dimensions)
    assert.deepEqual([derived.width, derived.height], dimensions)
    const expectedModel = models.find(({ file }) => file === modelId + '.onnx')
    assert.equal(result.enhance.model, modelId)
    assert.equal(result.enhance.revision, expectedModel.revision)
    assert.equal(result.enhance.sourceId, sourceId)
    assert.equal(result.enhance.sourceName, path.basename(file))
    assert.deepEqual(result.enhance.sourceEdit, sourceEdit)
    assert.deepEqual(state.photos.find(({ id }) => id === sourceId).edit, sourceEdit)
    assert.equal(result.enhance.mode, mode)
    assert.equal(result.enhance.strength, 1)
    assert.equal(result.enhance.scale, mode === 'denoise' ? 1 : 3)
    assert.ok(result.enhance.metrics.inferenceMs > 0)
    const decoded = decode(await exportBytes(name))
    assert.deepEqual([decoded.width, decoded.height], dimensions)
    return { decoded, provenance: result.enhance }
  }

  const importedOriginal = await exportBytes('source-before.png')
  assert.deepEqual(importedOriginal, Buffer.from(bytes))
  const inputMse = mseAgainstClean(decode(importedOriginal), clean)
  const denoise = await enhance(
    'denoise',
    'oidn-rt-ldr-small',
    {},
    [size, size],
    'noisy-portrait-Denoised.png'
  )
  const denoisedMse = mseAgainstClean(denoise.decoded, clean)
  assert.ok(inputMse > 100)
  assert.ok(denoisedMse < inputMse * 0.7, `Denoise MSE ${denoisedMse} vs input ${inputMse}`)

  await selectSource()
  const crop = { x: 0.125, y: 0.25, w: 0.75, h: 0.5 },
    exposure = 0.25
  await call('edit', '--key', 'crop', '--value', JSON.stringify(crop))
  await call('edit', '--key', 'Exposure', '--value', String(exposure))
  const sourceEdit = { crop, Exposure: exposure },
    edited = decode(await exportBytes('source-edited.png', 'image/png'))
  assert.deepEqual([edited.width, edited.height], [72, 48])
  const enlarged = await enhance(
    'super-resolution',
    'espcn-x3',
    sourceEdit,
    [216, 144],
    'noisy-portrait-Enhanced-3x.png'
  )
  const comparison = checkLearnedLuma(enlarged.decoded, edited)
  const final = await call('state')
  assert.equal(final.photos.length, 3)
  assert.deepEqual(final.photos.find(({ id }) => id === sourceId).edit, sourceEdit)
  await selectSource()
  assert.deepEqual(await exportBytes('source-after.png'), importedOriginal)
  assert.deepEqual(await readFile(file), importedOriginal)
  assert.deepEqual(await readFile(portrait), original)
  console.log(
    JSON.stringify({
      nativeEnhance: 'passed',
      platform: process.platform,
      provisioning: 'pinned runtime fetch in a fresh native session',
      denoise: {
        model: denoise.provenance.model,
        revision: denoise.provenance.revision,
        inputMse,
        denoisedMse,
        inferenceMs: denoise.provenance.metrics.inferenceMs,
        dimensions: [size, size]
      },
      superResolution: {
        model: enlarged.provenance.model,
        revision: enlarged.provenance.revision,
        inferenceMs: enlarged.provenance.metrics.inferenceMs,
        dimensions: [216, 144],
        ...comparison
      },
      preservedOriginals: 1
    })
  )
})
