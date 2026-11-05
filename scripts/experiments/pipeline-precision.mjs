// Measurement only: actual legacy rendering and explicit numeric storage alternatives.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { serveWorkspace } from '../../tests/browser-server.mjs'

const server = await serveWorkspace()
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
try {
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const { render } = await import('./render.js')
    const { validateLocalTool } = await import('./local-tools.js')
    const source = document.createElement('canvas')
    source.width = 256
    source.height = 32
    const context = source.getContext('2d'),
      pixels = context.createImageData(256, 32)
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 256; x++) pixels.data.set([x, x, x, 255], (y * 256 + x) * 4)
    context.putImageData(pixels, 0, 0)
    const mask = validateLocalTool('mask', {
      type: 'radial',
      center: { x: 0.5, y: 0.5 },
      rx: 1,
      ry: 1,
      feather: 0,
      adjustments: { Exposure: 4 }
    })
    const output = render(source, { localTools: { masks: [mask] }, Exposure: -4 })
    const actual = output.getContext('2d').getImageData(0, 0, 256, 32).data
    const row = Array.from({ length: 256 }, (_, x) => actual[x * 4])
    const legacy = {
      maxByteError: Math.max(...row.map((v, i) => Math.abs(v - i))),
      distinctLevels: new Set(row).size,
      samples: [16, 64, 128, 192, 255].map((x) => ({ input: x, output: row[x] }))
    }
    if (typeof Math.f16round !== 'function')
      throw Error('This precision experiment requires native Math.f16round')
    const quantizers = {
      unorm8: (x) => Math.round(Math.min(1, Math.max(0, x)) * 255) / 255,
      unorm16: (x) => Math.round(Math.min(1, Math.max(0, x)) * 65535) / 65535,
      float16: Math.f16round,
      float32: Math.fround,
      float64: (x) => x
    }
    const numeric = {}
    // No tone mapper: +4/-4 EV must be an identity in an unbounded linear buffer.
    // Include negative components needed by matrix conversions, and values above display white.
    for (const [name, quantize] of Object.entries(quantizers)) {
      let maximum = 0,
        sum = 0,
        nonFinite = 0
      const distinct = new Set()
      const samples = 65536
      for (let i = 0; i < samples; i++) {
        const input = -0.25 + (i / (samples - 1)) * 16.25
        const output = quantize(quantize(quantize(input) * 16) / 16)
        if (!Number.isFinite(output)) nonFinite++
        const error = Math.abs(output - input)
        maximum = Math.max(maximum, error)
        sum += error
        distinct.add(output)
      }
      numeric[name] = {
        samples,
        maxAbsoluteError: maximum,
        meanAbsoluteError: sum / samples,
        distinctLevels: distinct.size,
        nonFinite
      }
    }
    return { legacy, numeric, browser: navigator.userAgent }
  })
  // Explicit hypotheses: expose the current loss, and verify the proposed CPU precision.
  assert.ok(result.legacy.maxByteError > 150)
  assert.ok(result.numeric.unorm16.maxAbsoluteError > 15)
  assert.ok(result.numeric.float16.maxAbsoluteError > 0.001)
  assert.ok(result.numeric.float32.maxAbsoluteError < 0.000001)
  assert.equal(result.numeric.float32.distinctLevels, 65536)
  assert.equal(result.numeric.float32.nonFinite, 0)
  await mkdir('.workspace/precision', { recursive: true })
  await writeFile('.workspace/precision/pipeline-results.json', JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
  server.close()
}
