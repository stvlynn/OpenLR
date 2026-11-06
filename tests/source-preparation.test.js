import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('linear source preparation preserves samples, ownership and correction order', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)

  const results = await page.evaluate(async () => {
    const { prepareDehaze, renderFrame, renderFramePrepared } = await import('./render.js')
    const { analyzeDehaze } = await import('./dehaze.js')
    const { renderCorrectedFrame } = await import('./frame-render.js')
    const { filledFrame } = await import('./fill.js')
    const { correctEyesFrame } = await import('./culling.js')
    const { applyLocalTools, validateLocalTool } = await import('./local-tools.js')
    const { warpOpticsFrame } = await import('./optics.js')
    const { deflateSync } = await import('./vendor/fflate/browser.js')
    const { getImageWorkerDiagnostics } = await import('./image-worker.js')

    const width = 8,
      height = 6
    const storage = new Float32Array(width * height * 4 + 8)
    const data = storage.subarray(4, -4)
    for (let p = 0; p < width * height; p++)
      data.set([1.15 + p / 64, (p % 9) / 64 - 0.0625, 0.015625, [0, 0.5, 1][p % 3]], p * 4)
    const input = { width, height, data, colorSpace: 'srgb-linear' }
    const snapshot = ({ data, ...frame }) => ({ ...frame, data: Array.from(data) })
    const original = snapshot(input)

    const fills = [
      {
        x: 0,
        y: 0,
        w: 0.25,
        h: 0.5,
        width: 1,
        height: 1,
        rgba: btoa(String.fromCharCode(...deflateSync(Uint8Array.of(255, 0, 0, 255))))
      }
    ]
    const redEyes = [{ x: 0.1875, y: 0.25, rx: 0.25, ry: 0.25 }]
    const localTools = {
      repairs: [
        validateLocalTool('repair', {
          type: 'clone',
          source: { x: 0.1875, y: 0.25 },
          points: [{ x: 0.6875, y: 0.25 }],
          radius: 0.16,
          feather: 0
        })
      ]
    }
    const optics = { shiftX: 12, rotate: 4 }
    const recipes = [
      ['absent corrections', {}, false],
      ['empty correction lists', { fills: [], redEyes: [] }, false],
      ['present neutral branches', { localTools: {}, optics: { enabled: false } }, false],
      ['fill', { fills }, true],
      ['red-eye correction', { redEyes }, true],
      ['local repair', { localTools }, true],
      ['optics', { optics }, true],
      ['combined corrections', { fills, redEyes, localTools, optics }, true]
    ]

    const comparisons = []
    for (const [label, recipe, changesSource] of recipes) {
      const owned = { ...input, data: Float32Array.from(original.data) }
      const filled = filledFrame(owned, recipe.fills)
      const correctedEyes = correctEyesFrame(filled, recipe.redEyes)
      const local = applyLocalTools(correctedEyes, recipe.localTools)
      const expected = warpOpticsFrame(local, recipe.optics, input)
      const edit = {
        ...recipe,
        Dehaze: 40,
        Exposure: 0.25,
        crop: { x: 0.125, y: 0, w: 0.75, h: 1 },
        flip: true,
        turn: 1
      }
      const prepared = await prepareDehaze(input, edit)
      const reference = snapshot(renderCorrectedFrame(expected, edit, 5, input, analyzeDehaze(expected)))
      comparisons.push({
        label,
        changesSource,
        prepared: snapshot(prepared.source),
        expected: snapshot(expected),
        separateBuffer: prepared.source.data.buffer !== input.data.buffer,
        rendered: snapshot(await renderFramePrepared(input, edit, 5)),
        synchronous: snapshot(renderFrame(input, { ...edit, Dehaze: 0 }, 5)),
        synchronousReference: snapshot(
          renderCorrectedFrame({ ...expected, data: expected.data.slice() }, { ...edit, Dehaze: 0 }, 5, input)
        ),
        reference,
        after: snapshot(input)
      })
    }

    const errors = []
    const invalidSample = (index, value) => {
      const invalid = { ...input, data: data.slice() }
      invalid.data[index] = value
      return invalid
    }
    for (const invalid of [
      invalidSample(0, NaN),
      invalidSample(1, Infinity),
      invalidSample(2, -Infinity),
      invalidSample(3, NaN),
      invalidSample(3, -0.1),
      invalidSample(3, 1.1),
      { ...input, width: width + 1 }
    ]) {
      try {
        await prepareDehaze(invalid, { Dehaze: 40 })
        errors.push(null)
      } catch (error) {
        errors.push([error.name, error.message])
      }
    }

    return { comparisons, original, errors, diagnostics: getImageWorkerDiagnostics() }
  })

  for (const result of results.comparisons)
    await t.test(result.label, () => {
      assert.deepEqual(result.prepared, result.expected)
      if (result.changesSource) assert.notDeepEqual(result.prepared, results.original)
      else assert.deepEqual(result.prepared, results.original)
      assert.ok(result.separateBuffer)
      assert.deepEqual(result.after, results.original)
      assert.deepEqual(result.rendered, result.reference)
      assert.deepEqual(result.synchronous, result.synchronousReference)
    })

  await t.test('rejects malformed linear samples before worker transfer', () => {
    assert.deepEqual(results.errors, [
      ['TypeError', 'Invalid linear pixel sample'],
      ['TypeError', 'Invalid linear pixel sample'],
      ['TypeError', 'Invalid linear pixel sample'],
      ['TypeError', 'Invalid linear pixel sample'],
      ['TypeError', 'Invalid linear pixel sample'],
      ['TypeError', 'Invalid linear pixel sample'],
      ['TypeError', 'Invalid pixel frame dimensions or sample count']
    ])
  })
  assert.deepEqual(results.diagnostics, [])
})
