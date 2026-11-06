import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { makePng } from '../tests/fixtures/png.mjs'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const width = 96,
  height = 64,
  colors = [
    [48, 76, 112],
    [161, 60, 110]
  ],
  names = ['adjustment.png', 'other.png'],
  folderId = 'adjustment-fixtures'
const bytes = colors.map((rgb) =>
  Buffer.from(
    makePng({
      width,
      height,
      bits: 8,
      data: Array(width * height)
        .fill(rgb)
        .flat()
    })
  )
)

// The native WebView encodes the returned PNG. Inspect it with a separate decoder
// and calculate the Exposure expectation from the fixture's known sRGB samples.
function exposure(rgb, stops) {
  return rgb.map((byte) => {
    const srgb = byte / 255
    const linear = ((srgb + 0.055) / 1.055) ** 2.4
    const exposed = linear * 2 ** stops
    return Math.round(255 * (1.055 * exposed ** (1 / 2.4) - 0.055))
  })
}

function sample({ width, height, data }) {
  const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
  const rgba = Array.from(data.subarray(offset, offset + 4), (value) => Math.round(value * 255))
  assert.equal(rgba.pop(), 255)
  return rgba
}

function assertColor({ width, height, data }, rgb) {
  assert.ok(width > 0 && height > 0)
  assert.equal(data.length, width * height * 4)
  const rgba = [...rgb, 255]
  for (let i = 0; i < data.length; i++) {
    const expected = rgba[i % 4]
    const actual = Math.round(data[i] * 255)
    if (actual !== expected) assert.equal(actual, expected, `Unexpected rendered sample at ${i}`)
  }
}

function hasColorPatch({ width, height, data }, rgb) {
  // Look for a contiguous rectangle in the actual captured workspace. A few
  // matching UI pixels cannot stand in for a rendered photo patch.
  const heights = new Uint32Array(width),
    tolerance = 4 / 255,
    [red, green, blue] = rgb.map((channel) => channel / 255)
  for (let y = 0; y < height; y++) {
    let run = 0
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const matching =
        Math.abs(data[i] - red) <= tolerance &&
        Math.abs(data[i + 1] - green) <= tolerance &&
        Math.abs(data[i + 2] - blue) <= tolerance
      heights[x] = matching ? heights[x] + 1 : 0
      run = heights[x] >= 16 ? run + 1 : 0
      if (run >= 24) return true
    }
  }
  return false
}

function assertHistogram(bins, rgb) {
  const expected = [...rgb, Math.round(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2])]
  const count = bins.red[rgb[0]]
  assert.ok(count > 0)
  for (const [i, channel] of ['red', 'green', 'blue', 'luma'].entries()) {
    const values = Array(256).fill(0)
    values[expected[i]] = count
    assert.deepEqual(bins[channel], values)
  }
}

await withNativeWorkspace(
  process.argv[2],
  async ({ root, call, initial, restart }) => {
    assert.deepEqual(initial.photos, [])
    assert.equal(initial.adjustmentDraft, null)
    const run = (command, args = {}) => call(command, '--args', JSON.stringify(args))
    const openFolder = async () => {
      const opened = await run('local-open', { root: folderId })
      assert.equal(opened.photos, names.length)
      assert.deepEqual(opened.warnings, [])
    }
    const select = (id) => run('select', { id })
    const snapshot = () => run('state')
    let serial = 0
    const save = (command, args = {}) =>
      call(command, '--args', JSON.stringify(args), '--output', path.join(root, `adjustment-${serial++}.png`))
    const image = async (command = 'preview', args = {}) => {
      const { width, height, data } = readPng(await readFile((await save(command, args)).path))
      return { width, height, data }
    }
    const exported = () => image('export', { format: 'image/png' })
    const draftImage = (id) => image('preview', { source: 'draft', draftId: id })

    await openFolder()
    const photos = (await snapshot()).photos
    const [first, second] = names.map((name) => photos.find((photo) => photo.name === name).id)
    await select(first)
    await run('view', { mode: 'detail' })
    const photo = (state, id = first) => state.photos.find((item) => item.id === id)
    const recipe = async () => photo(await snapshot()).edit
    const sidecar = () => readFile(path.join(root, 'photos', names[0] + '.openlr.json'))
    const neutral = await image()
    assert.deepEqual([neutral.width, neutral.height], [width, height])
    assertColor(neutral, colors[0])
    const originalEdit = await recipe()
    assert.deepEqual(originalEdit, {})

    const scalar = (value, args = {}) => ({ key: 'Exposure', value, photoId: first, ...args })
    await run('edit', scalar(0.25))
    const baselineEdit = await recipe(),
      baseline = await exported(),
      baselineSidecar = await sidecar(),
      baselineRgb = exposure(colors[0], 0.25)
    assert.deepEqual(baselineEdit, { Exposure: 0.25 })
    assertColor(baseline, baselineRgb)
    const stage = async (command, args) => {
      const result = await run(command, { photoId: first, ...args, draft: true })
      assert.equal(result.command, command)
      assert.equal(result.photoId, first)
      assert.equal(typeof result.id, 'string')
      assert.ok(result.id)
      assert.ok(['pending', 'ready'].includes(result.status))
      return result.id
    }
    const ready = async (id) => {
      const deadline = performance.now() + 5000
      do {
        const { adjustmentDraft } = await run('state', { summary: true })
        assert.equal(adjustmentDraft?.id, id)
        if (adjustmentDraft.status === 'ready') {
          assert.deepEqual((await snapshot()).adjustmentDraft, adjustmentDraft)
          return adjustmentDraft
        }
        assert.equal(adjustmentDraft.status, 'pending')
        await delay(30)
      } while (performance.now() < deadline)
      assert.fail('The staged adjustment did not publish a ready preview')
    }
    const cancel = (id) => run('draft-cancel', { id })
    const commit = (id) => run('draft-commit', { id })
    const assertBaseline = async () => {
      assert.deepEqual(await recipe(), baselineEdit)
      assert.deepEqual(await sidecar(), baselineSidecar)
      assert.deepEqual(await image(), baseline)
      assert.deepEqual(await exported(), baseline)
    }

    const curve = await stage('curve-set', {
      channel: 'red',
      points: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.8 },
        { x: 1, y: 1 }
      ]
    })
    await ready(curve)
    const curveRgb = sample(await draftImage(curve))
    assert.ok(curveRgb[0] > baselineRgb[0] + 10)
    assert.deepEqual(curveRgb.slice(1), baselineRgb.slice(1))
    await cancel(curve)
    assert.equal((await snapshot()).adjustmentDraft, null)

    const grading = await stage('grading-set', { value: { global: { luminance: 40 } } })
    await ready(grading)
    const gradingRgb = sample(await draftImage(grading))
    assert.ok(gradingRgb.every((value, i) => value > baselineRgb[i] + 10))
    await select(second)
    assert.equal((await snapshot()).adjustmentDraft, null)
    await assert.rejects(commit(grading), /draft|adjustment/i)
    assert.deepEqual(photo(await snapshot(), second).edit, {})
    assertColor(await image(), colors[1])
    await select(first)
    await assertBaseline()

    const superseded = await stage('edit', scalar(-1))
    const current = await stage('edit', scalar(1))
    assert.notEqual(current, superseded)
    for (const operation of [cancel, commit, draftImage])
      await assert.rejects(operation(superseded), /draft|adjustment/i)
    await assert.rejects(
      run('edit', scalar(2, { photoId: second, draft: true })),
      /selected photo|selection|photo changed/i
    )
    const published = await ready(current)
    assert.equal(published.args.key, 'Exposure')
    assert.equal(published.args.value, 1)
    const draft = await draftImage(current)
    const committedRgb = exposure(colors[0], 1)
    assertColor(draft, committedRgb)
    assertHistogram(await run('histogram', { source: 'display' }), committedRgb)
    assertHistogram(await run('histogram'), baselineRgb)
    assert.ok(
      hasColorPatch(await image('screenshot'), committedRgb),
      'Native workspace must show the draft pixels'
    )
    await assertBaseline()

    await commit(current)
    assert.equal((await snapshot()).adjustmentDraft, null)
    assert.deepEqual(await recipe(), { Exposure: 1 })
    const committed = await exported()
    assertColor(committed, committedRgb)
    await run('undo')
    assert.deepEqual(await recipe(), baselineEdit)
    assert.deepEqual(await exported(), baseline)
    await run('undo')
    assert.deepEqual(await recipe(), originalEdit)
    assert.deepEqual(await exported(), neutral)
    await run('redo')
    assert.deepEqual(await recipe(), baselineEdit)
    await run('redo')
    assert.deepEqual(await exported(), committed)

    const abandoned = await stage('edit', scalar(-1))
    await ready(abandoned)
    const abandonedRgb = exposure(colors[0], -1)
    assertColor(await draftImage(abandoned), abandonedRgb)
    const committedSidecar = await sidecar()
    assert.deepEqual(JSON.parse(committedSidecar).recipe.edit, { Exposure: 1 })
    assert.equal((await restart()).adjustmentDraft, null)
    await openFolder()
    await select(first)
    await run('view', { mode: 'detail' })
    assert.equal((await snapshot()).adjustmentDraft, null)
    assert.deepEqual(await recipe(), { Exposure: 1 })
    assert.deepEqual(await sidecar(), committedSidecar)
    assert.deepEqual(await exported(), committed)
    await assert.rejects(commit(abandoned), /draft|adjustment/i)
    const original = await save('export', { format: 'original' })
    assert.deepEqual(await readFile(original.path), bytes[0])
    for (const [i, name] of names.entries())
      assert.deepEqual(await readFile(path.join(root, 'photos', name)), bytes[i])
    console.log(
      JSON.stringify({
        nativeAdjustment: 'passed',
        baselineRgb,
        draftRgb: committedRgb,
        curveRgb,
        gradingRgb,
        abandonedRgb,
        reopened: true,
        preservedOriginals: names.length
      })
    )
  },
  {
    async prepare({ root }) {
      // The private fixture registry grants access only to the generated folder.
      const folder = path.join(root, 'photos')
      await mkdir(folder)
      for (const [i, name] of names.entries()) await writeFile(path.join(folder, name), bytes[i])
      await writeFile(
        path.join(root, 'folders.json'),
        JSON.stringify([{ id: folderId, name: 'Adjustment fixtures', path: folder }])
      )
    }
  }
)
