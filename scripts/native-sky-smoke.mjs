import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute, parse } from '../cli/openlr.mjs'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const photo = fileURLToPath(new URL('../tests/fixtures/ai/rocket.jpg', import.meta.url))
// Manual interior probes from the licensed rocket fixture's benchmark.
const regions = {
  sky: [
    [0.16, 0.08, 0.09, 0.45],
    [0.56, 0.07, 0.1, 0.45]
  ],
  nonSky: [
    [0.49, 0.4, 0.02, 0.3],
    [0.45, 0.965, 0.1, 0.025]
  ]
}

function regionMean({ width, height }, rectangles, sample) {
  let sum = 0,
    count = 0
  for (const [x, y, w, h] of rectangles)
    for (let row = Math.ceil(y * height); row < (y + h) * height; row++)
      for (let column = Math.ceil(x * width); column < (x + w) * width; column++) {
        sum += sample((row * width + column) * 4)
        count++
      }
  return sum / count
}

const luma = (pixels, i) => 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]
const toLinear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
const toSrgb = (value) => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055)

await withNativeWorkspace(process.argv[2], async ({ root, session, call, initial }) => {
  assert.deepEqual(initial.photos, [])
  const original = await readFile(photo),
    imported = await call('import', photo)
  assert.deepEqual(imported.failed, [])
  assert.equal(imported.added.length, 1)
  const [photoId] = imported.added
  const run = (command, args = {}) => call(command, '--args', JSON.stringify(args))
  const image = async (name, command = 'export', args = { format: 'image/png' }) => {
    const saved = await call(
      command,
      '--args',
      JSON.stringify(args),
      '--output',
      path.join(root, name + '.png')
    )
    assert.equal(saved.mimeType, 'image/png')
    const pixels = readPng(await readFile(saved.path))
    assert.deepEqual([pixels.width, pixels.height], [640, 427])
    return pixels
  }
  await run('view', { mode: 'detail' })
  const baseline = await image('baseline')
  console.log('Native Sky provisioning: pinned first-use runtime fetch in a fresh native session')
  // This one command includes a 172 MB first-use download and full inference.
  const mask = await execute(
    parse(['ai-mask', '--target', 'sky', '--photoId', photoId, '--session', session, '--timeout', '180'])
  )
  const state = await call('state'),
    [stored] = state.photos.find(({ id }) => id === photoId).edit.localTools.masks,
    { provenance, raster } = stored
  assert.equal(mask.target, 'sky')
  assert.equal(stored.id, mask.id)
  assert.equal(state.localSelection.id, mask.id)
  assert.deepEqual(stored.adjustments, {})
  assert.equal(provenance.target, 'sky')
  assert.equal(provenance.model, 'detr-panoptic-fp32.onnx')
  assert.equal(provenance.revision, 'ea24b2d4e0bfae31f0a1299ba3fb892a2df064de')
  assert.deepEqual([provenance.label, provenance.labelName], [187, 'sky-other-merged'])
  assert.deepEqual([provenance.sourceWidth, provenance.sourceHeight], [640, 427])
  assert.deepEqual([provenance.inputWidth, provenance.inputHeight], [767, 512])
  assert.deepEqual([raster.width, raster.height, raster.encoding], [192, 128, 'base64-u8'])
  assert.ok(mask.metrics.inferenceMs > 0)

  const coverage = await image('coverage', 'mask-preview', { id: mask.id, style: 'gray' })
  const values = new Set()
  for (let i = 0; i < coverage.data.length; i += 4) {
    const value = coverage.data[i]
    assert.equal(value, coverage.data[i + 1])
    assert.equal(value, coverage.data[i + 2])
    assert.equal(coverage.data[i + 3], 1)
    values.add(value)
  }
  assert.ok(values.size > 16, 'Sky mask coverage should include soft levels')
  const sky = regionMean(coverage, regions.sky, (i) => coverage.data[i]),
    nonSky = regionMean(coverage, regions.nonSky, (i) => coverage.data[i])
  assert.ok(sky > 0.95 && nonSky < 0.1, `Unexpected Sky coverage: ${sky} / ${nonSky}`)

  assert.deepEqual((await image('neutral')).data, baseline.data)
  await run('mask.update', { photoId, id: mask.id, changes: { adjustments: { Exposure: -1 } } })
  const edited = await image('edited')
  let maxChannelError = 0
  for (let i = 0; i < edited.data.length; i += 4) {
    assert.equal(edited.data[i + 3], baseline.data[i + 3])
    const weight = coverage.data[i]
    for (let c = 0; c < 3; c++) {
      const before = baseline.data[i + c]
      // One stop halves linear intensity. Original mode blends in encoded sRGB.
      const expected = before * (1 - weight) + toSrgb(toLinear(before) / 2) * weight
      const error = Math.abs(Math.round(255 * edited.data[i + c]) - Math.round(255 * expected))
      maxChannelError = Math.max(maxChannelError, error)
    }
  }
  // The PNG rounds soft coverage separately from final photo channel rounding.
  assert.ok(maxChannelError <= 1, `Sky exposure differed by ${maxChannelError} codes`)
  const skyDarkening = regionMean(edited, regions.sky, (i) => luma(baseline.data, i) - luma(edited.data, i)),
    nonSkyDifference = regionMean(edited, regions.nonSky, (i) =>
      Math.abs(luma(baseline.data, i) - luma(edited.data, i))
    )
  const savedOriginal = await call(
    'export',
    '--format',
    'original',
    '--output',
    path.join(root, 'original.jpg')
  )
  assert.deepEqual(await readFile(savedOriginal.path), original)
  assert.deepEqual(await readFile(photo), original)
  await call('undo')
  assert.deepEqual((await image('undo')).data, baseline.data)
  console.log(
    'Native Sky smoke passed ' +
      JSON.stringify({
        metrics: mask.metrics,
        coverage: { sky, nonSky, levels: values.size },
        lumaBytes: { skyDarkening: skyDarkening * 255, nonSkyDifference: nonSkyDifference * 255 },
        maxChannelError
      })
  )
})
