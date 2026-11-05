import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { makePng } from '../tests/fixtures/png.mjs'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

await withNativeWorkspace(process.argv[2], async ({ root, call, initial }) => {
  assert.deepEqual(initial.photos, [])
  const width = 96,
    height = 64,
    data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const red = Math.abs(y - 31) <= 1 && (Math.abs(x - 23) <= 1 || Math.abs(x - 71) <= 1)
      data.set(red ? [245, 29, 22] : [96, 96, 96], (y * width + x) * 3)
    }
  const bytes = Buffer.from(makePng({ width, height, bits: 8, data }))
  const file = path.join(root, 'flash.png')
  await writeFile(file, bytes)
  const imported = await call('import', file)
  assert.deepEqual(imported.failed, [])
  assert.equal(imported.added.length, 1)
  const photoId = imported.added[0]
  const recipe = (state) => state.photos.find(({ id }) => id === photoId).edit
  const run = (command, args = {}) => call(command, '--args', JSON.stringify(args))
  let serial = 0
  const image = async (command = 'export', args = { format: 'image/png' }) => {
    const result = await call(
      command,
      '--args',
      JSON.stringify(args),
      '--output',
      path.join(root, `${serial++}.png`)
    )
    return readPng(await readFile(result.path))
  }
  const pixel = ({ width, data }, x, y) =>
    Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (value) =>
      Math.round(value * 255)
    )
  await run('view', { mode: 'detail' })
  await run('red-eye', { x: 23.5 / width, y: 31.5 / height, radius: 0.08 })
  const state = await run('mask.add', {
    mask: {
      type: 'color-range',
      color: '#f51d16',
      tolerance: 0.01,
      softness: 0,
      adjustments: { Exposure: 1 }
    }
  })
  const id = recipe(state).localTools.masks[0].id
  const cases = []
  for (const [version, algorithm] of [
    [1, 'ns'],
    [2, 'telea']
  ]) {
    await run('processing', { version })
    const before = await image()
    const coverage = await image('mask-preview', { id })
    const probes = [pixel(coverage, 23, 31), pixel(coverage, 71, 31)]
    assert.deepEqual(probes, [
      [0, 0, 0, 255],
      [255, 255, 255, 255]
    ])
    assert.ok(pixel(before, 23, 31)[0] < 30)
    for (const [key, value] of [
      ['aspect', '1'],
      ['turn', 1],
      ['flip', true]
    ])
      await run('edit', { key, value })
    const transformed = await image('mask-preview', { id })
    const rendered = await image()
    assert.deepEqual([transformed.width, transformed.height], [64, 64])
    assert.deepEqual([rendered.width, rendered.height], [64, 64])
    assert.deepEqual([pixel(transformed, 32, 56), pixel(transformed, 32, 8)], probes)
    assert.deepEqual(
      [pixel(rendered, 32, 56), pixel(rendered, 32, 8)],
      [pixel(before, 23, 31), pixel(before, 71, 31)]
    )
    for (let i = 0; i < 3; i++) await call('undo')
    const removed = recipe(await run('remove-mask', { id, algorithm }))
    assert.equal(removed.localTools.masks.length, 0)
    const patch = removed.fills[0]
    assert.deepEqual([patch.x, patch.y, patch.width, patch.height], [70 / width, 30 / height, 3, 3])
    const output = await image()
    const target = pixel(output, 71, 31)
    assert.ok(target.slice(0, 3).every((value) => Math.abs(value - 96) <= 6))
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (Math.abs(x - 71) <= 1 && Math.abs(y - 31) <= 1) continue
        assert.deepEqual(pixel(output, x, y), pixel(before, x, y))
      }
    assert.equal(recipe(await call('undo')).localTools.masks[0].id, id)
    assert.deepEqual((await image()).data, before.data)
    cases.push({
      version,
      algorithm,
      coverage: probes.map((p) => p[0]),
      corrected: pixel(output, 23, 31),
      target,
      transformedSize: [64, 64]
    })
  }
  const original = await call('export', '--format', 'original', '--output', path.join(root, 'original.png'))
  assert.deepEqual(await readFile(original.path), bytes)
  assert.deepEqual(await readFile(file), bytes)
  console.log(JSON.stringify({ nativeMask: 'passed', cases, preservedOriginals: 1 }))
})
