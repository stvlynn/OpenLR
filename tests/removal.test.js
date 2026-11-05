import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'

test('content-aware removal uses surrounding pixels; both solvers preserve unmasked pixels and original bytes', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const results = await page.evaluate(async () => {
    const { run } = await import('./app.js'),
      size = 128
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const pattern = ctx.createImageData(size, size)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        pattern.data.set([40 + x * 0.6 + y * 0.5, 70 + x * 0.3 + y * 0.6, 160 + x * 0.2 - y * 0.5, 255], i)
      }
    ctx.putImageData(pattern, 0, 0)
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(60, 48, 8, 32)
    const damaged = ctx.getImageData(0, 0, size, size)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    const file = new File([blob], 'scratched.png', { type: 'image/png' })
    await run('import', { files: [file] })
    const stats = []
    for (const algorithm of ['telea', 'ns']) {
      await run('mask.add', {
        mask: {
          type: 'brush',
          points: [
            { x: 0.5, y: 0.375 },
            { x: 0.5, y: 0.625 }
          ],
          radius: 0.05,
          feather: 0,
          adjustments: {}
        }
      })
      const start = performance.now()
      await run('remove-mask', { algorithm })
      const elapsed = Math.round(performance.now() - start)
      const { blob: result } = await run('export', { format: 'image/png' }),
        image = await createImageBitmap(result)
      ctx.drawImage(image, 0, 0)
      image.close()
      const { data } = ctx.getImageData(0, 0, size, size)
      let error = 0,
        referenceError = 0,
        outside = 0
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
          for (let c = 0; c < 3; c++) {
            const i = (y * size + x) * 4 + c
            if (x >= 60 && x < 68 && y >= 48 && y < 80) {
              error += Math.abs(data[i] - pattern.data[i])
              referenceError += Math.abs(damaged.data[i] - pattern.data[i])
            }
            if (x < 55 || x > 73 || y < 39 || y > 89) outside += Math.abs(data[i] - damaged.data[i])
          }
      stats.push({
        algorithm,
        ms: elapsed,
        mae: error / (8 * 32 * 3),
        damagedMAE: referenceError / (8 * 32 * 3),
        outside
      })
      await run('reset')
    }
    const { blob: original } = await run('export', { format: 'original' })
    return {
      stats,
      originalUnchanged:
        String(new Uint8Array(await original.arrayBuffer())) ===
        String(new Uint8Array(await file.arrayBuffer()))
    }
  })
  console.log('Inpaint ablation', results.stats)
  assert.equal(results.originalUnchanged, true)
  for (const sample of results.stats) {
    assert.ok(sample.mae < sample.damagedMAE * 0.1)
    assert.equal(sample.outside, 0)
  }
})

test('mask preview uses the rendered aspect and inpainting excludes red-eye-corrected color samples', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const width = 96,
    height = 64,
    data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const red = Math.abs(y - 31) <= 1 && (Math.abs(x - 23) <= 1 || Math.abs(x - 71) <= 1)
      data.set(red ? [245, 29, 22, 255] : [96, 96, 96, 255], (y * width + x) * 4)
    }
  const source = makePng({ width, height, bits: 8, colorType: 6, data })
  const results = await page.evaluate(async (bytes) => {
    const run = window.openlr.run,
      file = new File([Uint8Array.from(bytes)], 'flash.png', { type: 'image/png' })
    const decode = async ({ blob }) => {
      const image = await createImageBitmap(blob),
        canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(image, 0, 0)
      image.close()
      return ctx.getImageData(0, 0, canvas.width, canvas.height)
    }
    const pixel = ({ width, data }, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)],
      image = () => run('export', { format: 'image/png' }).then(decode)
    await run('import', { files: [file] })
    await run('view', { mode: 'detail' })
    await run('red-eye', { x: 23.5 / 96, y: 31.5 / 64, radius: 0.08 })
    const state = await run('mask.add', {
      mask: {
        type: 'color-range',
        color: '#f51d16',
        tolerance: 0.01,
        softness: 0,
        adjustments: { Exposure: 1 }
      }
    })
    const id = state.photos[0].edit.localTools.masks[0].id,
      preview = () => run('mask-preview', { id }).then(decode),
      cases = []
    for (const [version, algorithm] of [
      [1, 'ns'],
      [2, 'telea']
    ]) {
      await run('processing', { version })
      const before = await image(),
        coverage = await preview()
      await run('edit', { key: 'aspect', value: '1' })
      await run('edit', { key: 'turn', value: 1 })
      await run('edit', { key: 'flip', value: true })
      const transformed = await preview(),
        rendered = await image()
      await run('undo')
      await run('undo')
      await run('undo')
      const removed = (await run('remove-mask', { id, algorithm })).photos[0].edit,
        output = await image()
      let outside = 0
      for (let y = 0; y < before.height; y++)
        for (let x = 0; x < before.width; x++) {
          if (Math.abs(x - 71) <= 1 && Math.abs(y - 31) <= 1) continue
          const start = (y * before.width + x) * 4
          for (let channel = 0; channel < 4; channel++)
            outside += Math.abs(before.data[start + channel] - output.data[start + channel])
        }
      const restored = (await run('undo')).photos[0].edit,
        restoredImage = await image()
      cases.push({
        version,
        before: [pixel(before, 23, 31), pixel(before, 71, 31)],
        coverage: [pixel(coverage, 23, 31), pixel(coverage, 71, 31)],
        transformedSize: [transformed.width, transformed.height],
        renderedSize: [rendered.width, rendered.height],
        // The square crops 16 columns on each side. Reflecting horizontally
        // then turning clockwise places the original red patches here.
        transformed: [pixel(transformed, 32, 56), pixel(transformed, 32, 8)],
        transformedPhoto: [pixel(rendered, 32, 56), pixel(rendered, 32, 8)],
        patch: removed.fills[0],
        maskConsumed: removed.localTools.masks.length === 0,
        target: pixel(output, 71, 31),
        outside,
        restored:
          restored.localTools.masks[0].id === id &&
          before.data.every((value, index) => restoredImage.data[index] === value)
      })
    }
    const original = new Uint8Array(await (await run('export', { format: 'original' })).blob.arrayBuffer())
    return {
      cases,
      originalUnchanged: original.length === bytes.length && original.every((v, i) => v === bytes[i])
    }
  }, Array.from(source))
  assert.equal(results.originalUnchanged, true)
  for (const result of results.cases) {
    const label = 'Processing version ' + result.version,
      expected = [
        [0, 0, 0, 255],
        [255, 255, 255, 255]
      ]
    assert.ok(result.before[0][0] < 30 && result.before[1][0] >= 245, label)
    assert.deepEqual(result.coverage, expected, label)
    assert.deepEqual(result.renderedSize, [64, 64], label)
    assert.deepEqual(result.transformedSize, [64, 64], label)
    assert.deepEqual(result.transformed, expected, label)
    assert.deepEqual(result.transformedPhoto, result.before, label)
    assert.deepEqual(
      [result.patch.x, result.patch.y, result.patch.width, result.patch.height],
      [70 / 96, 30 / 64, 3, 3],
      label
    )
    assert.equal(result.maskConsumed, true, label)
    assert.ok(
      result.target.slice(0, 3).every((value) => Math.abs(value - 96) <= 6),
      label
    )
    assert.equal(result.outside, 0, label)
    assert.equal(result.restored, true, label)
  }
})
