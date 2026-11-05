import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('linear mask previews select precise pre-mask samples and retain original coordinates', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const results = await page.evaluate(async () => {
    const { maskCoverageSource, renderMaskPreview } = await import('./mask-preview.js')
    const { removeMaskedArea } = await import('./remove-mask.js')
    const { bindWorkingFrame } = await import('./working-frames.js')
    const { frameCanvas } = await import('./render.js')
    const { validateLocalTool } = await import('./local-tools.js')
    const { encodeSoftMask } = await import('./soft-mask.js')
    const { deflateSync } = await import('./vendor/fflate/browser.js')
    const { decodeSrgb } = await import('./color-spaces.js')
    const frame = (samples, width = samples.length / 4) => ({
      width,
      height: samples.length / 4 / width,
      data: Float32Array.from(samples),
      colorSpace: 'srgb-linear'
    })
    const gray = (values) => frame(values.flatMap((v) => [v, v, v, 1]))
    const surface = (input) => bindWorkingFrame(frameCanvas(input), input)
    const range = (min, max) => validateLocalTool('mask', { type: 'luminance-range', min, max, softness: 0 })
    const pixels = (canvas) =>
      Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)
    const values = (canvas) => pixels(canvas).filter((_, i) => i % 4 === 0)
    const coverage = (input, edit, tool, options = {}) =>
      maskCoverageSource(surface(input), edit, tool, { style: 'gray', ...options })
    const exact = decodeSrgb(128 / 255),
      nearby = decodeSrgb(128 / 255 + 0.0002),
      colorInput = gray([exact, nearby, 4, -0.2]),
      colorBefore = Array.from(colorInput.data),
      color = validateLocalTool('mask', {
        type: 'color-range',
        color: '#808080',
        tolerance: 0.00001,
        softness: 0
      }),
      composite = validateLocalTool('mask', {
        type: 'composite',
        operation: 'intersect',
        components: [color, { type: 'radial', center: { x: 0.5, y: 0.5 }, rx: 1, ry: 1, feather: 0 }]
      }),
      linearColor = values(coverage(colorInput, { processVersion: 2 }, composite)),
      legacyColor = values(coverage(colorInput, {}, color)),
      luminanceInput = gray([-0.2, 0.01, 0.5, 2]),
      linearLuminance = values(coverage(luminanceInput, { processVersion: 2 }, range(0, 1))),
      legacyLuminance = values(coverage(luminanceInput, {}, range(0, 1)))

    // Both center samples encode to the same display byte. Only the first is
    // inside the Linear range. Sending its coverage reference to the worker
    // must preserve the separately owned decoded source.
    const removalInput = frame(
        Array.from({ length: 25 }, (_, i) => {
          const value = i === 12 ? exact : i === 13 ? nearby : 0.1
          return [value, value, value, 1]
        }).flat(),
        5
      ),
      removalBefore = Array.from(removalInput.data),
      removal = await removeMaskedArea(
        surface(removalInput),
        { processVersion: 2, localTools: { masks: [color] } },
        color,
        'ns',
        3
      )

    // The red fill becomes black after red-eye correction, then clone copies
    // that corrected result. All three stages must precede the range snapshot.
    const stagedInput = frame([
        0, 0.2, 0, 1, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1
      ]),
      stagedBefore = Array.from(stagedInput.data),
      clone = validateLocalTool('repair', {
        type: 'clone',
        source: { x: 0.1, y: 0.5 },
        points: [{ x: 0.7, y: 0.5 }],
        radius: 0.1,
        feather: 0
      }),
      staged = values(
        coverage(
          stagedInput,
          {
            processVersion: 2,
            fills: [
              {
                x: 0,
                y: 0,
                w: 0.2,
                h: 1,
                width: 1,
                height: 1,
                rgba: btoa(String.fromCharCode(...deflateSync(Uint8Array.of(255, 0, 0, 255))))
              }
            ],
            redEyes: [{ x: 0.1, y: 0.5, rx: 0.1, ry: 1 }],
            localTools: { repairs: [clone] }
          },
          range(0, 0.00001)
        )
      )

    const unmodifiedInput = gray([0.01, 2, 4]),
      unmodifiedBefore = Array.from(unmodifiedInput.data),
      preMask = values(
        coverage(
          unmodifiedInput,
          {
            processVersion: 2,
            Exposure: 4,
            localTools: {
              masks: [
                validateLocalTool('mask', {
                  type: 'radial',
                  center: { x: 0.5, y: 0.5 },
                  rx: 1,
                  ry: 1,
                  feather: 0,
                  adjustments: { Exposure: 4 }
                })
              ],
              depth: { raster: encodeSoftMask({ width: 1, height: 1, mask: Uint8Array.of(0) }) },
              lensBlur: { enabled: true, amount: 0.15, min: 0.4, max: 0.6, softness: 0 }
            }
          },
          range(0, 0.02)
        )
      ),
      resizedInput = gray([0, 0.4, 0.6, 1]),
      resized = coverage(resizedInput, { processVersion: 2 }, range(0.19999, 0.20001), { maxEdge: 2 }),
      averagedCoverage = coverage(resizedInput, { processVersion: 2 }, range(0.39999, 0.40001), {
        maxEdge: 2
      }),
      averagedRgba = coverage(resizedInput, { processVersion: 2 }, range(0.39999, 0.40001), {
        maxEdge: 2,
        style: 'rgba'
      }),
      previewCoverage = renderMaskPreview(
        surface(resizedInput),
        { processVersion: 2 },
        range(0.39999, 0.40001),
        { maxSize: 2 }
      ),
      resizedRepair = coverage(
        resizedInput,
        {
          processVersion: 2,
          localTools: {
            repairs: [
              validateLocalTool('repair', {
                type: 'clone',
                source: { x: 0.125, y: 0.5 },
                points: [{ x: 0.375, y: 0.5 }],
                radius: 0.1,
                feather: 0
              })
            ]
          }
        },
        range(0, 0.00001),
        { maxEdge: 2 }
      ),
      rgba = coverage(colorInput, { processVersion: 2 }, color, { style: 'rgba' }),
      geometryInput = frame([0.01, 0.01, 0.01, 1, 2, 2, 2, 1, 0.01, 0.01, 0.01, 1, 2, 2, 2, 1], 2),
      transformed = renderMaskPreview(
        surface(geometryInput),
        { processVersion: 2, flip: true, turn: 1 },
        range(0, 0.02)
      )
    let missingSource
    try {
      maskCoverageSource(frameCanvas(colorInput), { processVersion: 2 }, color)
    } catch (error) {
      missingSource = error.message
    }
    return {
      linearColor,
      legacyColor,
      linearLuminance,
      legacyLuminance,
      removalPatch: removal.postRepairFills[0],
      removalBefore,
      removalAfter: Array.from(removalInput.data),
      colorBefore,
      colorAfter: Array.from(colorInput.data),
      staged,
      stagedBefore,
      stagedAfter: Array.from(stagedInput.data),
      preMask,
      unmodifiedBefore,
      unmodifiedAfter: Array.from(unmodifiedInput.data),
      resized: { width: resized.width, height: resized.height, values: values(resized) },
      averagedCoverage: values(averagedCoverage),
      averagedRgba: pixels(averagedRgba).filter((_, i) => i % 4 === 3),
      previewCoverage: values(previewCoverage),
      resizedRepair: values(resizedRepair),
      rgba: pixels(rgba),
      transformed: { width: transformed.width, height: transformed.height, values: values(transformed) },
      missingSource
    }
  })
  await t.test('range selection distinguishes sub-byte colors and signed HDR luminance', () => {
    assert.deepEqual(results.linearColor, [255, 0, 0, 0])
    assert.deepEqual(results.legacyColor, [255, 255, 0, 0])
    assert.deepEqual(results.linearLuminance, [0, 255, 255, 0])
    assert.deepEqual(results.legacyLuminance, [255, 255, 255, 255])
    assert.deepEqual(results.rgba, [255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  })
  await t.test('inpainting uses float coverage without detaching the decoded source', () => {
    const { x, y, width, height } = results.removalPatch
    assert.deepEqual([x, y, width, height], [0.4, 0.4, 1, 1])
    assert.deepEqual(results.removalAfter, results.removalBefore)
  })
  await t.test('fill, red-eye and repairs precede the immutable range reference', () => {
    assert.deepEqual(results.staged, [255, 0, 0, 255, 0])
    assert.deepEqual(results.stagedAfter, results.stagedBefore)
    assert.deepEqual(results.colorAfter, results.colorBefore)
  })
  await t.test('depth blur, earlier masks and global edits do not change the selected range', () => {
    assert.deepEqual(results.preMask, [255, 0, 0])
    assert.deepEqual(results.unmodifiedAfter, results.unmodifiedBefore)
  })
  await t.test(
    'coverage resizing cannot invent selected colors and retains original-coordinate repair footprints',
    () => {
      assert.deepEqual(results.resized, { width: 2, height: 1, values: [0, 0] })
      assert.deepEqual(results.averagedCoverage, [127, 0])
      assert.deepEqual(results.averagedRgba, results.averagedCoverage)
      assert.deepEqual(results.previewCoverage, results.averagedCoverage)
      assert.deepEqual(results.resizedRepair, [255, 0])
      assert.deepEqual(results.transformed, { width: 2, height: 2, values: [0, 0, 255, 255] })
      assert.match(results.missingSource, /matching decoded source/)
    }
  )
})
