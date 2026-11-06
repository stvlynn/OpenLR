import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { makePng } from '../tests/fixtures/png.mjs'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const width = 128,
  height = 96,
  gray = [80, 80, 80],
  cloneA = [172, 60, 32],
  cloneB = [40, 140, 220],
  markers = [
    { x: 7, y: 8, rgb: [40, 182, 205] },
    { x: 120, y: 88, rgb: [185, 125, 36] }
  ]

function fixture() {
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rgb = gray
      if (Math.abs(x - 32) <= 7 && Math.abs(y - 28) <= 7) rgb = cloneA
      if (Math.abs(x - 96) <= 7 && Math.abs(y - 28) <= 7) rgb = cloneB
      if (Math.abs(x - 28) <= 4 && Math.abs(y - 70) <= 4) rgb = Array(3).fill(100 + 12 * (x - 28))
      for (const marker of markers)
        if (Math.abs(x - marker.x) <= 3 && Math.abs(y - marker.y) <= 3) rgb = marker.rgb
      data.set(rgb, (y * width + x) * 3)
    }
  }
  return Buffer.from(makePng({ width, height, bits: 8, data }))
}

const point = (x, y) => ({ x: (x + 0.5) / width, y: (y + 0.5) / height })
const dims = (image) => [image.width, image.height]
const pixel = ({ width, data }, x, y) => {
  const offset = (y * width + x) * 4
  return Array.from(data.subarray(offset, offset + 4), (value) => Math.round(value * 255))
}
function assertImage(actual, expected) {
  assert.deepEqual(dims(actual), dims(expected))
  assert.deepEqual(actual.data, expected.data)
}
function assertPixelNear(actual, expected, tolerance = 1) {
  assert.ok(
    actual.every((value, channel) => Math.abs(value - expected[channel]) <= tolerance),
    `Expected ${actual} within ${tolerance} codes of ${expected}`
  )
}

// Locate the photo in the capture using two generated color markers. Their
// pixels have zero composite coverage, and the hidden-overlay frame is stable.
function photoProjection(image) {
  const located = markers.map(({ rgb }) => {
    const [red, green, blue] = rgb.map((value) => value / 255)
    const tolerance = 5 / 255
    const xs = [],
      ys = []
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4
        if (
          Math.abs(image.data[i] - red) > tolerance ||
          Math.abs(image.data[i + 1] - green) > tolerance ||
          Math.abs(image.data[i + 2] - blue) > tolerance
        )
          continue
        xs.push(x)
        ys.push(y)
      }
    }
    assert.ok(xs.length >= 16, `Missing the rendered photo marker ${rgb}`)
    return [xs.sort((a, b) => a - b), ys].map((values) => values[Math.floor(values.length / 2)])
  })
  const [[left, top], [right, bottom]] = located
  assert.ok(right > left && bottom > top)
  const [a, b] = markers
  return (x, y) => [
    Math.round(left + ((x - a.x) / (b.x - a.x)) * (right - left)),
    Math.round(top + ((y - a.y) / (b.y - a.y)) * (bottom - top))
  ]
}

await withNativeWorkspace(process.argv[2], async ({ root, call, initial }) => {
  assert.deepEqual(initial.photos, [])
  const bytes = fixture()
  const source = path.join(root, 'local-tools.png')
  await writeFile(source, bytes)
  const { added, failed } = await call('import', source)
  assert.deepEqual(failed, [])
  assert.equal(added.length, 1)
  const [photoId] = added
  const run = (command, args = {}, ...flags) => call(command, '--args', JSON.stringify(args), ...flags)
  const local = (command, args) => run(command, { photoId, ...args })
  const tools = (state) => state.photos.find(({ id }) => id === photoId).edit.localTools
  const state = () => call('state')
  const edit = (key, value) => run('edit', { key, value })
  let sequence = 0
  const png = async (command, args = {}) => {
    const response = await run(command, args, '--output', path.join(root, `image-${sequence++}.png`))
    assert.equal(response.mimeType, 'image/png')
    return readPng(await readFile(response.path))
  }
  const exported = () => png('export', { format: 'image/png' })
  const coverage = (args = {}) => png('mask-preview', args)
  const overlay = async (enabled) => {
    const { result, frame } = await run(
      'mask-overlay',
      { enabled },
      '--capture',
      path.join(root, `overlay-${enabled}.png`)
    )
    assert.deepEqual(result, { visible: enabled })
    assert.equal(frame.mimeType, 'image/png')
    return readPng(await readFile(frame.path))
  }

  await run('view', { mode: 'detail', inspector: false })
  await run('panel', { name: 'photos', open: false })
  await call('film')
  const baseline = await exported()
  assert.deepEqual(dims(baseline), [width, height])
  const horizontal = { type: 'linear', start: point(16, 48), end: point(112, 48) }
  const [first] = tools(await local('mask.add', { mask: horizontal })).masks
  assertImage(await exported(), baseline)
  assert.deepEqual((await state()).localSelection, { id: first.id, path: [], overlay: true })

  await local('mask.update', { id: first.id, changes: { adjustments: { Saturation: -25 } } })
  const adjustments = { Saturation: -25, Exposure: 1 }
  const halfMask = tools(
    await local('mask.update', {
      id: first.id,
      changes: { opacity: 0.5, adjustments: { Exposure: 1 } }
    })
  ).masks[0]
  assert.equal(halfMask.opacity, 0.5)
  assert.deepEqual(halfMask.adjustments, adjustments)
  const softened = await exported()
  assert.deepEqual(pixel(softened, 16, 48), pixel(baseline, 16, 48))
  // Legacy local exposure doubles linear light before blending encoded bytes.
  const linearGray = ((gray[0] / 255 + 0.055) / 1.055) ** 2.4
  const exposedGray = 255 * (1.055 * (2 * linearGray) ** (1 / 2.4) - 0.055)
  const halfExposure = Math.round((gray[0] + exposedGray) / 2)
  assertPixelNear(pixel(softened, 112, 48), [halfExposure, halfExposure, halfExposure, 255])
  assert.deepEqual(pixel(await coverage({ id: first.id }), 64, 48), [64, 64, 64, 255])
  await assert.rejects(
    local('mask.update', {
      id: first.id,
      photoId: 'stale',
      changes: { opacity: 0 }
    }),
    /selected photo changed/
  )
  assert.deepEqual(tools(await state()).masks[0], halfMask)
  await local('mask.update', { id: first.id, changes: { opacity: 1 } })

  const vertical = {
    type: 'linear',
    start: point(64, 16),
    end: point(64, 80),
    adjustments: { Exposure: -1 }
  }
  const beforeCombine = tools(await local('mask.add', { mask: vertical }))
  const secondId = beforeCombine.masks[1].id
  const combined = tools(await local('mask.combine', { id: first.id, operandId: secondId, operation: 'add' }))
  const [group] = combined.masks
  assert.deepEqual(
    combined.masks.map(({ id }) => id),
    [first.id]
  )
  assert.deepEqual(
    group.components.map(({ id, adjustments }) => ({ id, adjustments })),
    [
      { id: first.id, adjustments: {} },
      { id: secondId, adjustments: {} }
    ]
  )
  assert.deepEqual(group.adjustments, adjustments)
  assert.deepEqual(tools(await call('undo')), beforeCombine)
  assert.deepEqual(tools(await call('redo')), combined)
  await assert.rejects(coverage({ id: secondId }), /Choose an existing mask/)

  const probes = [
    [16, 16],
    [112, 16],
    [16, 80],
    [112, 80],
    [64, 48]
  ]
  const operationSamples = {}
  for (const [operation, expected] of [
    ['add', [0, 255, 255, 255, 191]],
    ['subtract', [0, 255, 0, 0, 64]],
    ['intersect', [0, 0, 0, 255, 64]]
  ]) {
    if (operation === 'subtract') {
      assert.deepEqual(tools(await call('undo')), beforeCombine)
      const changed = tools(await local('mask.combine', { id: first.id, operandId: secondId, operation }))
        .masks[0]
      assert.deepEqual(changed, { ...group, operation })
    } else if (operation === 'intersect') {
      const changed = tools(await local('mask.update', { id: first.id, changes: { operation } })).masks[0]
      assert.deepEqual(changed, { ...group, operation })
    }
    const image = await coverage({ id: first.id })
    assert.deepEqual(dims(image), [width, height])
    operationSamples[operation] = probes.map(([x, y], i) => {
      const value = expected[i],
        actual = pixel(image, x, y)
      assertPixelNear(actual, [value, value, value, 255])
      return actual[0]
    })
  }

  const selection = { id: first.id, path: [1], overlay: true }
  assert.deepEqual(await local('local-select', { id: first.id, path: [1] }), selection)
  await assert.rejects(
    local('mask.component-update', {
      id: first.id,
      path: [1, 0],
      changes: { invert: true }
    }),
    /Component path was not found/
  )
  const inverted = tools(
    await local('mask.component-update', {
      id: first.id,
      path: [1],
      changes: { invert: true }
    })
  )
  assert.deepEqual(inverted.masks[0], {
    ...group,
    operation: 'intersect',
    components: [group.components[0], { ...group.components[1], invert: true }]
  })
  assert.deepEqual((await state()).localSelection, selection)
  assert.deepEqual((await call('state', '--summary', 'true')).localSelection, selection)
  const selected = await coverage()
  const rootGray = await coverage({ id: first.id })
  const rootRgba = await coverage({ id: first.id, style: 'rgba' })
  assert.deepEqual(pixel(selected, 16, 16), [255, 255, 255, 255])
  assert.deepEqual(pixel(selected, 16, 80), [0, 0, 0, 255])
  assert.deepEqual(pixel(rootGray, 16, 16), [0, 0, 0, 255])
  assert.deepEqual(pixel(rootGray, 112, 16), [255, 255, 255, 255])
  assertPixelNear(pixel(rootRgba, 64, 48), [255, 0, 0, 64])
  assert.deepEqual(pixel(rootRgba, 112, 16), [255, 0, 0, 255])
  assert.equal(pixel(rootRgba, 16, 16)[3], 0)

  const masked = await exported()
  const fullExposure = Math.round(exposedGray)
  assertPixelNear(pixel(masked, 112, 16), [fullExposure, fullExposure, fullExposure, 255])
  assert.deepEqual(pixel(masked, 16, 16), pixel(baseline, 16, 16))
  const shown = await overlay(true)
  const hidden = await overlay(false)
  assert.deepEqual(dims(shown), dims(hidden))
  const project = photoProjection(hidden)
  const covered = [64, 10],
    uncovered = [64, 88]
  const coveredBefore = pixel(hidden, ...project(...covered)),
    coveredAfter = pixel(shown, ...project(...covered))
  assertPixelNear(coveredBefore, pixel(masked, ...covered), 5)
  assert.ok(coveredAfter[0] - coveredBefore[0] > 20 && coveredBefore[1] - coveredAfter[1] > 10)
  const uncoveredBefore = pixel(hidden, ...project(...uncovered)),
    uncoveredAfter = pixel(shown, ...project(...uncovered))
  assertPixelNear(uncoveredBefore, pixel(masked, ...uncovered), 5)
  assertPixelNear(uncoveredAfter, uncoveredBefore, 1)
  assertImage(await exported(), masked)
  assert.deepEqual((await state()).localSelection, { ...selection, overlay: false })

  // The central crop is 64×48, and the square aspect trims eight more
  // pixels from each side. Flip followed by a quarter turn maps (u,v)
  // inside that square to (47-v,47-u).
  for (const [key, value] of [
    ['crop', { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }],
    ['aspect', '1'],
    ['flip', true],
    ['turn', 1]
  ])
    await edit(key, value)
  const transformed = await coverage({ id: first.id, style: 'rgba' })
  const transformedPhoto = await exported()
  assert.deepEqual(dims(transformed), [48, 48])
  assert.deepEqual(dims(transformedPhoto), [48, 48])
  for (const [[x, y], [u, v]] of [
    [
      [48, 32],
      [39, 39]
    ],
    [
      [80, 64],
      [7, 7]
    ]
  ]) {
    assertPixelNear(pixel(transformed, u, v), pixel(rootRgba, x, y))
    assert.deepEqual(pixel(transformedPhoto, u, v), pixel(masked, x, y))
  }
  for (let i = 0; i < 4; i++) await call('undo')
  assertImage(await exported(), masked)

  assert.deepEqual(tools(await local('mask.remove', { id: first.id })).masks, [])
  assert.deepEqual((await state()).localSelection, { id: '', path: [], overlay: false })
  await assert.rejects(coverage(), /Choose an existing mask/)
  assertImage(await exported(), baseline)
  assert.deepEqual(tools(await call('undo')), inverted)
  assertImage(await coverage({ id: first.id }), rootGray)
  assert.deepEqual(tools(await call('redo')).masks, [])

  const cloneTarget = [58, 64],
    clone = {
      type: 'clone',
      source: point(32, 28),
      points: [point(...cloneTarget)],
      radius: 4.1 / height,
      feather: 0
    }
  const [cloneRecipe] = tools(await local('repair.add', { repair: clone })).repairs
  assert.deepEqual((await state()).localSelection, { id: cloneRecipe.id, path: [], overlay: false })
  const cloned = await exported()
  assert.deepEqual(pixel(cloned, ...cloneTarget), [...cloneA, 255])
  assert.deepEqual(pixel(cloned, 66, 64), pixel(baseline, 66, 64))
  const cloneChanges = { source: point(96, 28), opacity: 0.5 }
  await assert.rejects(
    local('repair.update', {
      id: cloneRecipe.id,
      photoId: 'stale',
      changes: cloneChanges
    }),
    /selected photo changed/
  )
  assert.deepEqual(tools(await state()).repairs, [cloneRecipe])
  const updatedClone = tools(await local('repair.update', { id: cloneRecipe.id, changes: cloneChanges }))
    .repairs[0]
  assert.deepEqual(updatedClone, { ...cloneRecipe, ...cloneChanges })
  const cloneMixed = await exported()
  const mixedPixel = [...gray.map((value, c) => (value + cloneB[c]) / 2), 255]
  assert.deepEqual(pixel(cloneMixed, ...cloneTarget), mixedPixel)
  assert.deepEqual(pixel(cloneMixed, 66, 64), pixel(baseline, 66, 64))
  assert.deepEqual(tools(await local('repair.remove', { id: cloneRecipe.id })).repairs, [])
  assert.equal((await state()).localSelection.id, '')
  assertImage(await exported(), baseline)
  assert.deepEqual(tools(await call('undo')).repairs, [updatedClone])
  assertImage(await exported(), cloneMixed)
  assert.deepEqual(tools(await call('redo')).repairs, [])

  const heal = { ...clone, type: 'heal', source: point(28, 70), points: [point(64, 70)] }
  const [healRecipe] = tools(await local('repair.add', { repair: heal })).repairs
  const healed = await exported()
  // The source ramp is symmetric about gray 100 and the destination is flat
  // gray 80. Mean matching keeps the source's ±24-code texture around gray 80.
  const healPair = (image) => [pixel(image, 62, 70), pixel(image, 66, 70)]
  assert.deepEqual(healPair(healed), [
    [56, 56, 56, 255],
    [104, 104, 104, 255]
  ])
  assert.deepEqual(pixel(healed, 64, 70), [...gray, 255])
  const [updatedHeal] = tools(
    await local('repair.update', { id: healRecipe.id, changes: { opacity: 0.5 } })
  ).repairs
  assert.deepEqual(updatedHeal, { ...healRecipe, opacity: 0.5 })
  const halfHeal = await exported()
  assert.deepEqual(healPair(halfHeal), [
    [68, 68, 68, 255],
    [92, 92, 92, 255]
  ])
  assert.deepEqual(pixel(halfHeal, 72, 70), pixel(baseline, 72, 70))
  assert.deepEqual(tools(await local('repair.remove', { id: healRecipe.id })).repairs, [])
  assertImage(await exported(), baseline)

  // Probe the staged overlay and saved output at original-image pixel
  // centers. The 48×48 square covers x=40..87, y=24..71 and the flip/turn
  // maps an original (x,y) to (71-y,87-x) within that square.
  for (const [key, value] of [
    ['crop', { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }],
    ['aspect', '1'],
    ['flip', true],
    ['turn', 1]
  ])
    await edit(key, value)
  const projected = (image, x, y) =>
    pixel(image, Math.floor(((71.5 - y) * image.width) / 48), Math.floor(((87.5 - x) * image.height) / 48))
  const stroke = { points: [point(64, 64), point(64, 65)], radius: 4.1 / height, feather: 0 }
  const drafts = [
    { ...stroke, type: 'brush' },
    { type: 'linear', start: point(46, 44), end: point(82, 44) },
    { type: 'radial', center: point(64, 64), rx: 8 / width, ry: 6 / height, feather: 0 },
    { ...stroke, type: 'clone', source: clone.source },
    { ...stroke, type: 'heal', source: heal.source }
  ]
  const draftSamples = {}
  const draftImage = (draftId) => png('preview', { source: 'local-draft', draftId })
  for (const version of [1, 2]) {
    await local('processing', { version })
    const saved = await exported()
    assert.deepEqual(dims(saved), [48, 48])
    const savedRecipe = tools(await state())
    draftSamples[version] = {}
    for (const recipe of drafts) {
      const { type } = recipe,
        kind = recipe.source ? 'repair' : 'mask',
        command = kind + '.add',
        candidate = recipe.source ? recipe : { ...recipe, adjustments: { Exposure: 1 } },
        target = type === 'linear' ? [86, 44] : [64, 64],
        exterior = type === 'linear' ? [42, 44] : [44, 30]
      await local('local-tool', { tool: type })
      await run('mask-overlay', { enabled: true })
      const stage = () => local(command, { [kind]: candidate, draft: true })
      const draft = await stage()
      assert.ok(draft.id, type)
      assert.equal(draft.command, command)
      assert.equal(draft.photoId, photoId)
      assert.equal(draft.args[kind].type, type)
      assert.equal(draft.status, 'ready')
      assert.equal(draft.visible, true)
      assert.deepEqual((await call('state', '--summary', 'true')).localDraft, draft)
      const current = await state()
      assert.deepEqual(current.localDraft, draft)
      assert.deepEqual(tools(current), savedRecipe)
      assertImage(await exported(), saved)

      const visible = await draftImage(draft.id)
      assert.equal(visible.width, visible.height)
      assert.ok(visible.width >= 48)
      const inside = projected(visible, ...target),
        outside = projected(visible, ...exterior)
      assertPixelNear(inside, kind === 'mask' ? [255, 0, 0, 76] : [255, 177, 92, 115], 3)
      assert.deepEqual(outside, [0, 0, 0, 0])
      draftSamples[version][type] = { inside, outside }

      if (type === 'brush') {
        await assert.rejects(coverage(), /Choose an existing mask/)
        await run('mask-overlay', { enabled: false })
        assert.equal((await state()).localDraft.visible, false)
        const hiddenDraft = await draftImage(draft.id)
        assert.deepEqual(dims(hiddenDraft), dims(visible))
        assert.ok(
          hiddenDraft.data.every((value) => value === 0),
          'hidden overlay PNG is transparent'
        )
        await run('mask-overlay', { enabled: true })
      }
      assert.deepEqual(await run('draft-cancel', { id: draft.id }), { canceled: true })
      assert.equal((await state()).localDraft, null)
      await assert.rejects(run('draft-commit', { id: draft.id }), /draft changed/i)
      const next = await stage()
      assert.notEqual(next.id, draft.id)
      const committed = await run('draft-commit', { id: next.id })
      assert.equal(committed.localDraft, null)
      const collection = kind === 'mask' ? 'masks' : 'repairs'
      assert.deepEqual(
        tools(committed)[collection].map((item) => item.type),
        [type]
      )
      const output = await exported()
      assert.deepEqual(projected(output, ...exterior), projected(saved, ...exterior))
      if (type === 'clone') assert.deepEqual(projected(output, ...target), [...cloneA, 255])
      else if (type === 'heal') {
        assert.ok(projected(output, 62, 64)[0] < gray[0] - 10)
        assert.ok(projected(output, 66, 64)[0] > gray[0] + 10)
      } else assert.ok(projected(output, ...target)[0] > projected(saved, ...target)[0] + 25)
      assert.deepEqual(tools(await call('undo')), savedRecipe)
      assertImage(await exported(), saved)
    }
  }

  const original = await call('export', '--format', 'original', '--output', path.join(root, 'original.png'))
  assert.deepEqual(await readFile(original.path), bytes)
  assert.deepEqual(await readFile(source), bytes)
  console.log(
    JSON.stringify({
      nativeLocalTools: 'passed',
      operationSamples,
      componentAndRoot: [pixel(selected, 16, 16)[0], pixel(rootGray, 16, 16)[0]],
      overlay: { coveredBefore, coveredAfter, uncoveredBefore, uncoveredAfter },
      transformedSize: dims(transformed),
      clone: [[...cloneA, 255], mixedPixel],
      heal: [healPair(healed), healPair(halfHeal)],
      draftSamples,
      preservedOriginals: 1
    })
  )
})
