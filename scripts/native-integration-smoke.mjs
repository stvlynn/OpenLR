import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { frame, png, scene } from '../tests/fixtures/merge-scene.js'
import { decodeRadiance } from '../tests/fixtures/radiance.mjs'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const output = path.resolve('.workspace/native-final')
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const dimensions = ({ width, height }) => [width, height]
const pixel = ({ width, data }, x, y) =>
  Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))
const byte = (value) => Math.round(value * 255)

function checkPanorama(image, { width, height, merge }) {
  assert.deepEqual(dimensions(image), [width, height])
  assert.ok(Math.abs(width - 720) < 8 && height >= 260 && height < 285)
  const { left, top, right, bottom } = merge.bounds
  assert.equal(right - left, width)
  assert.equal(bottom - top, height)
  assert.ok(Math.abs(left) < 4 && top <= -2 && bottom > 263)
  const worldPixel = (x, y) => pixel(image, x - left, y - top)
  const meanError = []
  // Check unique left/right content as well as both overlaps in scene space.
  for (const [start, end] of [
    [20, 165],
    [185, 355],
    [370, 535],
    [550, 700]
  ]) {
    let error = 0,
      count = 0
    for (let y = 40; y < 210; y += 13)
      for (let x = start; x < end; x += 17) {
        const sample = worldPixel(x, y),
          expected = frame(1, 1, { x, y }).data
        assert.equal(sample[3], 1, 'Panorama should cover the interior scene')
        for (let c = 0; c < 3; c++) error += Math.abs(byte(sample[c]) - expected[c])
        count++
      }
    const mae = error / (count * 3)
    assert.ok(mae < 9, 'Panorama mean absolute channel error was ' + mae)
    meanError.push(mae)
  }
  const uncoveredAlpha = [worldPixel(25, -2)[3], worldPixel(680, 263)[3]]
  assert.deepEqual(uncoveredAlpha, [0, 0])
  return { meanError, uncoveredAlpha }
}

function checkRadiance(image, { width, height, merge }) {
  assert.deepEqual(dimensions(image), [width, height])
  const { x: left, y: top } = merge.crop
  assert.ok(Math.abs(left - 5) < 4 && Math.abs(top - 3) < 4)
  let low = Infinity,
    high = 0
  for (let i = 0; i < image.pixels.length; i += 3) {
    const light = luma(image.pixels.subarray(i, i + 3))
    if (light > 0) low = Math.min(low, light)
    high = Math.max(high, light)
  }
  const stops = Math.log2(high / low)
  assert.ok(high > 1 && stops > 8)
  const sampledRelativeErrors = []
  for (const fraction of [0.2, 0.48, 0.7, 0.82, 0.94]) {
    const x = Math.floor(width * fraction),
      y = Math.floor(height * 0.48),
      start = (y * width + x) * 3,
      expected = scene(left + x, top + y, true)
    const errors = expected.map((value, c) => Math.abs(image.pixels[start + c] - value) / value)
    const maxError = Math.max(...errors)
    assert.ok(maxError < 0.12, 'Radiance error was ' + maxError)
    sampledRelativeErrors.push(maxError)
  }
  return { stops, maxLuma: high, sampledRelativeErrors }
}

function regionMean({ width, height, data }, rectangles) {
  let sum = 0,
    count = 0
  for (const [x, y, w, h] of rectangles)
    for (let row = Math.ceil(y * height); row < (y + h) * height; row++)
      for (let column = Math.ceil(x * width); column < (x + w) * width; column++) {
        sum += data[(row * width + column) * 4]
        count++
      }
  return sum / count
}

await mkdir(output, { recursive: true })
await withNativeWorkspace(process.argv[2], async ({ root, call, initial }) => {
  assert.deepEqual(initial.photos, [])
  const report = { platform: process.platform, checks: [] }
  const run = (command, args = {}) => call(command, '--args', JSON.stringify(args))
  const state = () => call('state')
  const row = (snapshot, id) => snapshot.photos.find((photo) => photo.id === id)
  const select = (id) => run('select', { id })
  const exportBytes = async (name, format = 'image/png', directory = output) => {
    const saved = await call('export', '--format', format, '--output', path.join(directory, name), '--force')
    return readFile(saved.path)
  }
  const exportRadiance = async (name) => {
    const saved = await call('export-hdr', '--output', path.join(output, name), '--force')
    assert.equal(saved.mimeType, 'image/vnd.radiance')
    return readFile(saved.path)
  }

  async function mergeSources(name, images, args = {}) {
    const inputs = images.map((image, i) => ({
      file: path.join(root, name + '-' + i + '.png'),
      bytes: png(image)
    }))
    await Promise.all(inputs.map(({ file, bytes }) => writeFile(file, bytes)))
    const imported = await call('import', ...inputs.map(({ file }) => file))
    assert.deepEqual(imported.failed, [])
    const ids = imported.added
    assert.equal(ids.length, inputs.length)
    await select(ids[0])
    await run('edit', { key: 'Exposure', value: 1.25 })
    await run('rate', { value: 3 })
    const version = await run('version-save', { name: 'Merge source' })
    const before = await state()
    const prepared = row(before, ids[0])
    assert.equal(prepared.edit.Exposure, 1.25)
    assert.equal(prepared.rating, 3)
    assert.equal(version.name, 'Merge source')
    assert.deepEqual(version.edit, prepared.edit)
    assert.deepEqual(prepared.versions, [version])
    const result = await run('merge-' + name, { ...args, ids })
    const after = await state()
    assert.equal(after.selected, result.id)
    assert.equal(after.photos.length, before.photos.length + 1)
    assert.deepEqual(row(after, result.id).edit, {})
    assert.deepEqual(
      result.merge.sources.map(({ id }) => id),
      ids
    )
    for (const id of ids) {
      const prior = row(before, id),
        current = row(after, id)
      for (const key of ['edit', 'rating', 'versions']) assert.deepEqual(current[key], prior[key])
    }
    return { result, ids, inputs }
  }
  async function checkOriginals({ ids, inputs }) {
    for (const [index, { file, bytes }] of inputs.entries()) {
      await select(ids[index])
      assert.deepEqual(await exportBytes('original-' + path.basename(file), 'original', root), bytes)
      assert.deepEqual(await readFile(file), bytes)
    }
    return inputs.length
  }

  const panorama = await mergeSources(
    'panorama',
    [
      { x: 0, y: 0 },
      { x: 180, y: 7 },
      { x: 360, y: -4 }
    ].map((offset) => frame(360, 260, offset))
  )
  const panoramaPixels = checkPanorama(readPng(await exportBytes('panorama.png')), panorama.result)
  report.checks.push({
    name: 'panorama',
    result: panorama.result,
    pixels: panoramaPixels,
    preservedOriginals: await checkOriginals(panorama)
  })

  const hdr = await mergeSources(
    'hdr',
    [{ ev: -2, x: 5, y: -3 }, { ev: 0 }, { ev: 2, x: -4, y: 2 }].map((offset) =>
      frame(600, 260, { ...offset, hdr: true })
    ),
    { evs: [-2, 0, 2] }
  )
  const radiance = await exportRadiance('merged.hdr')
  const hdrPixels = checkRadiance(decodeRadiance(radiance), hdr.result)
  const display = readPng(await exportBytes('hdr-tone-mapped.png'))
  assert.deepEqual(dimensions(display), [hdr.result.width, hdr.result.height])
  const y = Math.floor(display.height * 0.48)
  const toneSamples = [0.2, 0.7, 0.94].map((fraction) => {
    const rgba = pixel(display, Math.floor(display.width * fraction), y)
    assert.equal(rgba[3], 1)
    return byte(luma(rgba))
  })
  assert.ok(toneSamples[0] < toneSamples[1] && toneSamples[1] < toneSamples[2])
  assert.ok(toneSamples[2] - toneSamples[0] > 80)
  await run('edit', { key: 'Exposure', value: -0.75 })
  const editedDisplay = readPng(await exportBytes('hdr-display-edited.png'))
  assert.ok(luma(pixel(editedDisplay, Math.floor(display.width * 0.7), y)) < toneSamples[1] / 255)
  assert.deepEqual(await exportRadiance('edited-display-radiance.hdr'), radiance)
  report.checks.push({
    name: 'hdr',
    result: hdr.result,
    pixels: hdrPixels,
    toneSamples,
    preservedOriginals: await checkOriginals(hdr)
  })

  const crw = fileURLToPath(new URL('../tests/fixtures/raw/canon-powershot-g1.crw', import.meta.url))
  const before = await readFile(crw),
    raw = await call('import', crw)
  assert.equal(raw.failed.length, 0)
  const dng = await call(
    'export',
    '--format',
    'image/x-adobe-dng',
    '--output',
    path.join(output, 'canon-linear.dng'),
    '--force'
  )
  assert.ok(dng.bytes > 10_000_000)
  assert.deepEqual(await readFile(crw), before)
  report.checks.push({ name: 'real-crw-to-linear-dng', bytes: dng.bytes })

  const portrait = fileURLToPath(new URL('../tests/fixtures/ai/astronaut.png', import.meta.url))
  const portraitBytes = await readFile(portrait),
    aiPhoto = await call('import', portrait)
  assert.deepEqual(aiPhoto.failed, [])
  assert.equal(aiPhoto.added.length, 1)
  const [photoId] = aiPhoto.added
  await run('view', { mode: 'detail' })
  const baseline = readPng(await exportBytes('semantic-neutral.png'))
  const coverages = {},
    maskIds = {}
  // Manual interior regions retained by the approved astronaut benchmark.
  const interior = [
    [0.38, 0.15, 0.12, 0.19],
    [0.26, 0.5, 0.3, 0.2]
  ]
  const exterior = [
    [0.03, 0.05, 0.12, 0.2],
    [0.77, 0.03, 0.18, 0.2]
  ]
  for (const [target, model, size] of [
    ['person', 'pphumanseg.onnx', 192],
    ['subject', 'u2netp.onnx', 320],
    ['background', 'u2netp.onnx', 320]
  ]) {
    const result = await run('ai-mask', { target, photoId }),
      current = await state(),
      mask = row(current, photoId).edit.localTools.masks.find(({ id }) => id === result.id)
    assert.equal(result.target, target)
    assert.ok(result.metrics.inferenceMs > 0)
    assert.equal(mask.provenance.target, target)
    assert.equal(mask.provenance.model, model)
    assert.deepEqual([mask.raster.width, mask.raster.height, mask.raster.encoding], [size, size, 'base64-u8'])
    assert.deepEqual(mask.adjustments, {})
    assert.equal(current.localSelection.id, result.id)
    maskIds[target] = result.id
    const saved = await call(
      'mask-preview',
      '--id',
      result.id,
      '--style',
      'gray',
      '--output',
      path.join(output, 'semantic-' + target + '.png'),
      '--force'
    )
    assert.equal(saved.mimeType, 'image/png')
    const coverage = readPng(await readFile(saved.path))
    assert.deepEqual(dimensions(coverage), [512, 512])
    const values = new Set()
    for (let i = 0; i < coverage.data.length; i += 4) {
      const [red, green, blue, alpha] = coverage.data.subarray(i, i + 4)
      assert.equal(red, green)
      assert.equal(red, blue)
      assert.equal(alpha, 1)
      values.add(byte(red))
    }
    assert.ok(values.size > 16, 'Mask coverage should include soft levels')
    const inside = regionMean(coverage, interior),
      outside = regionMean(coverage, exterior)
    if (target === 'background') assert.ok(inside < 0.05 && outside > 0.9)
    else assert.ok(inside > 0.9 && outside < 0.05)
    coverages[target] = coverage
    report.checks.push({ name: 'ai-' + target, result, coverage: { inside, outside, levels: values.size } })
  }
  let complementError = 0
  for (let i = 0; i < coverages.subject.data.length; i += 4) {
    const difference = Math.abs(byte(coverages.subject.data[i]) + byte(coverages.background.data[i]) - 255)
    complementError = Math.max(complementError, difference)
  }
  assert.ok(complementError <= 2, 'Rendered Subject/Background complement error: ' + complementError)
  assert.deepEqual(readPng(await exportBytes('semantic-all-neutral.png')).data, baseline.data)
  await run('mask.update', { photoId, id: maskIds.person, changes: { adjustments: { Exposure: 1 } } })
  const exposed = readPng(await exportBytes('semantic-person-edited.png'))
  const insideBefore = pixel(baseline, 220, 128),
    insideAfter = pixel(exposed, 220, 128)
  assert.ok(byte(luma(insideAfter) - luma(insideBefore)) > 10)
  assert.deepEqual(pixel(exposed, 35, 51), pixel(baseline, 35, 51))
  assert.deepEqual(await exportBytes('original-astronaut.png', 'original', root), portraitBytes)
  assert.deepEqual(await readFile(portrait), portraitBytes)
  report.checks.push({ name: 'ai-pixels', complementError, insideBefore, insideAfter, preservedOriginals: 1 })

  const screenshot = await call('screenshot', '--output', path.join(output, 'workspace.png'), '--force')
  const image = await readFile(screenshot.path)
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  report.checks.push({ name: 'workspace-screenshot', bytes: screenshot.bytes })
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(
    'Native integrated smoke passed panorama pixels, HDR radiance and tone mapping, real Canon CRW to linear DNG, Person/Subject/Background coverage, and workspace capture. Artifacts: ' +
      output
  )
})
