import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute, parse } from '../cli/openlr.mjs'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const portrait = fileURLToPath(new URL('../tests/fixtures/ai/astronaut.png', import.meta.url))
const model = JSON.parse(await readFile(new URL('../research/ai/depth-weight.json', import.meta.url), 'utf8'))

function depthSampler({ width, height, data }) {
  const samples = Buffer.from(data, 'base64')
  assert.equal(samples.length, width * height)
  assert.ok(new Set(samples).size > 128, 'Depth should contain a diverse normalized map')
  assert.ok(samples.includes(0) && samples.includes(255), 'Depth should span its normalized endpoints')
  return (x, y) => {
    const u = Math.min(width - 1, Math.max(0, x * width - 0.5)),
      v = Math.min(height - 1, Math.max(0, y * height - 0.5))
    const left = Math.floor(u),
      top = Math.floor(v),
      right = Math.min(width - 1, left + 1),
      bottom = Math.min(height - 1, top + 1)
    const upper = samples[top * width + left] * (1 - u + left) + samples[top * width + right] * (u - left),
      lower = samples[bottom * width + left] * (1 - u + left) + samples[bottom * width + right] * (u - left)
    return (upper * (1 - v + top) + lower * (v - top)) / 255
  }
}

function rgbDifference(first, second, a, b = a) {
  return (
    Math.abs(first[a] - second[b]) +
    Math.abs(first[a + 1] - second[b + 1]) +
    Math.abs(first[a + 2] - second[b + 2])
  )
}

await withNativeWorkspace(process.argv[2], async ({ root, call, initial, session }) => {
  assert.deepEqual(initial.photos, [])
  const provisioning = 'pinned runtime fetch in a fresh native session'
  const original = await readFile(portrait),
    imported = await call('import', portrait)
  assert.deepEqual(imported.failed, [])
  assert.equal(imported.added.length, 1)
  const photoId = imported.added[0],
    run = (command, args = {}) => call(command, '--args', JSON.stringify(args))
  const recipe = async () => (await call('state')).photos.find((photo) => photo.id === photoId).edit
  let serial = 0
  const image = async (command = 'export', args = { format: 'image/png' }) => {
    const saved = await call(
      command,
      '--args',
      JSON.stringify(args),
      '--output',
      path.join(root, `depth-${serial++}.png`)
    )
    const { width, height, data } = readPng(await readFile(saved.path))
    return { width, height, pixels: Uint8Array.from(data, (value) => Math.round(value * 255)) }
  }
  await run('view', { mode: 'detail' })
  const baseline = await image()
  assert.deepEqual([baseline.width, baseline.height], [512, 512])
  console.log('Native depth provisioning: ' + provisioning)
  // A first-use download and inference can outlast the ordinary CLI request.
  // Surface failures without retrying a command that may have committed.
  const estimate = await execute(
    parse(['depth-estimate', '--photoId', photoId, '--session', session, '--timeout', '150'])
  )
  const depth = (await recipe()).localTools.depth,
    { raster, provenance } = depth
  assert.deepEqual(estimate.depth, provenance)
  assert.equal(provenance.model, 'depth-anything-v2-small-quantized.onnx')
  assert.equal(provenance.revision, model.revision)
  assert.deepEqual([provenance.sourceWidth, provenance.sourceHeight], [512, 512])
  assert.deepEqual([provenance.inputWidth, provenance.inputHeight], [518, 518])
  assert.deepEqual([raster.width, raster.height, raster.encoding], [518, 518, 'base64-u8'])
  assert.ok(estimate.metrics.inferenceMs > 0)
  assert.deepEqual(await image(), baseline, 'Estimating depth leaves rendered pixels unchanged')
  const sample = depthSampler(raster)
  const portraitDepth = sample(0.43, 0.25),
    backgroundDepth = sample(0.85, 0.1)
  assert.ok(portraitDepth - backgroundDepth > 0.1, 'The portrait probe should be closer than the background')
  const { width, height, pixels } = baseline,
    depthAt = Float64Array.from({ length: width * height }, (_, index) =>
      sample(((index % width) + 0.5) / width, (Math.floor(index / width) + 0.5) / height)
    )
  const range = { min: 0.15, max: 0.5, softness: 0 }
  const added = await run('depth-range', { ...range, photoId, adjustments: { Exposure: 0.7 } })
  const ranged = (await recipe()).localTools
  assert.equal(ranged.masks[0].id, added.maskId)
  assert.deepEqual(ranged.masks[0].raster, raster)
  assert.deepEqual(ranged.depth, depth)
  const mask = await image('mask-preview', { id: added.maskId }),
    brightened = await image()
  assert.deepEqual([mask.width, mask.height], [width, height])
  assert.deepEqual([brightened.width, brightened.height], [width, height])
  let rangeInside = 0,
    rangeOutside = 0,
    rangeChanged = 0
  for (let index = 0; index < depthAt.length; index++) {
    const value = depthAt[index],
      offset = index * 4
    // Exclude values within float rounding distance of the interval boundaries.
    if (Math.min(Math.abs(value - range.min), Math.abs(value - range.max)) < 1e-5) continue
    const inside = value >= range.min && value <= range.max
    const expected = inside ? 255 : 0
    for (let channel = 0; channel < 3; channel++)
      assert.equal(mask.pixels[offset + channel], expected, 'PNG coverage must follow inferred depth')
    assert.equal(mask.pixels[offset + 3], 255)
    if (inside) {
      rangeInside++
      for (let channel = 0; channel < 3; channel++)
        assert.ok(
          brightened.pixels[offset + channel] >= pixels[offset + channel],
          'Positive exposure must not darken included samples'
        )
      if (rgbDifference(pixels, brightened.pixels, offset)) rangeChanged++
    } else {
      rangeOutside++
      assert.equal(rgbDifference(pixels, brightened.pixels, offset), 0, 'Outside the range remains unchanged')
    }
  }
  assert.ok(rangeInside > 1000 && rangeOutside > 1000 && rangeChanged > rangeInside / 2)
  await call('undo')
  assert.deepEqual((await recipe()).localTools.depth, depth)
  assert.deepEqual(await image(), baseline)

  const focus = { min: 0.2, max: 0.45, softness: 0, amount: 0.04 }
  const applied = await run('lens-blur', { ...focus, photoId })
  assert.deepEqual(applied.lensBlur, { enabled: true, ...focus })
  assert.deepEqual((await recipe()).localTools.depth, depth)
  const blurred = await image()
  assert.deepEqual([blurred.width, blurred.height], [width, height])
  let focusCount = 0,
    defocusChanges = 0,
    edgeBefore = 0,
    edgeAfter = 0
  for (let index = 0; index < depthAt.length; index++) {
    const value = depthAt[index],
      offset = index * 4
    assert.equal(blurred.pixels[offset + 3], pixels[offset + 3])
    const difference = rgbDifference(pixels, blurred.pixels, offset)
    if (value > focus.min + 1e-5 && value < focus.max - 1e-5) {
      focusCount++
      assert.equal(difference, 0, 'Focused pixels stay sharp and unchanged')
    }
    if ((value < focus.min - 1e-5 || value > focus.max + 1e-5) && difference) defocusChanges++
    // Compare adjacent far-plane pixels, avoiding the focus boundary.
    if (index % width !== width - 1 && value < 0.1 && depthAt[index + 1] < 0.1) {
      edgeBefore += rgbDifference(pixels, pixels, offset, offset + 4)
      edgeAfter += rgbDifference(blurred.pixels, blurred.pixels, offset, offset + 4)
    }
  }
  assert.ok(focusCount > 1000 && defocusChanges > 1000)
  assert.ok(edgeBefore > 1000 && edgeAfter < edgeBefore * 0.75, 'Defocus should reduce far-plane texture')
  await assert.rejects(run('lens-blur', { min: 0.8, photoId }), /Focus minimum must not exceed maximum/)
  assert.deepEqual((await recipe()).localTools.lensBlur, applied.lensBlur)
  assert.deepEqual((await recipe()).localTools.depth, depth)
  assert.deepEqual(await image(), blurred)
  await run('lens-blur', { enabled: false, photoId })
  assert.deepEqual((await recipe()).localTools.depth, depth)
  assert.deepEqual(await image(), baseline)
  const saved = await call('export', '--format', 'original', '--output', path.join(root, 'original.png'))
  assert.deepEqual(await readFile(saved.path), original)
  assert.deepEqual(await readFile(portrait), original)
  console.log(
    JSON.stringify({
      nativeDepth: 'passed',
      platform: process.platform,
      provisioning,
      model: provenance.model,
      revision: provenance.revision,
      inferenceMs: estimate.metrics.inferenceMs,
      raster: [raster.width, raster.height],
      portraitDepth,
      backgroundDepth,
      rangeInside,
      rangeOutside,
      rangeChanged,
      focusCount,
      defocusChanges,
      edgeBefore,
      edgeAfter,
      preservedOriginals: 1
    })
  )
})
