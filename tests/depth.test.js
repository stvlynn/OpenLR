import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { encodeSoftMask } from '../web/soft-mask.js'
import { validateLocalTool, applyLocalTools } from '../web/local-tools.js'
import { validateDepthSettings, applyLensBlur } from '../web/depth-effects.js'
import { DEPTH_MODEL } from '../web/depth-kernel.js'
import { parse } from '../cli/openlr.mjs'

test('depth range and focus interval use actual supplied depth and preserve focused pixels/alpha', () => {
  const width = 40,
    height = 20,
    raster = encodeSoftMask({ width: 2, height: 1, mask: Uint8Array.from([30, 220]) }),
    data = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) =>
      i % 4 === 3 ? 255 : Math.floor(i / 4) % 2 ? 240 : 20
    )
  const original = data.slice(),
    settings = validateDepthSettings({ amount: 0.15, min: 0.75, max: 1, softness: 0 })
  applyLensBlur({ width, height, data }, { raster }, settings)
  assert.notEqual(data[4], original[4])
  assert.equal(data[(10 * width + 35) * 4], original[(10 * width + 35) * 4])
  assert.equal(data[3], 255)
  const mask = validateLocalTool('mask', {
      type: 'depth-range',
      raster,
      min: 0.75,
      max: 1,
      softness: 0,
      adjustments: { Exposure: 1 }
    }),
    pixels = { width: 2, height: 1, data: Uint8ClampedArray.from([100, 100, 100, 255, 100, 100, 100, 255]) }
  applyLocalTools(pixels, { masks: [mask] })
  assert.equal(pixels.data[0], 100)
  assert.ok(pixels.data[4] > 100)
  assert.equal(parse(['lens-blur', '--min', '0.2', '--max', '0.5', '--dry-run']).args.min, 0.2)
  assert.throws(() => validateDepthSettings({ min: 0.8, max: 0.2 }), /minimum/)
  assert.throws(() => validateDepthSettings({ custom: true }), /Invalid/)
})

let available = false
try {
  await stat(new URL('../.tools/ai-models/depth-model_quantized.onnx', import.meta.url))
  available = true
} catch {}
test(
  'real depth model UI focus changes, local mask pixels, restart cache and Worker fallback',
  { skip: !available },
  async (t) => {
    const server = createServer(async (req, res) => {
      try {
        const file = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html'
        if (file.includes('..')) throw Error()
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader(
          'Content-Type',
          /\.m?js$/.test(file)
            ? 'text/javascript'
            : file.endsWith('.wasm')
              ? 'application/wasm'
              : file.endsWith('.css')
                ? 'text/css'
                : 'text/html'
        )
        const path =
          file === 'depth.onnx'
            ? '../.tools/ai-models/depth-model_quantized.onnx'
            : file.startsWith('fixtures/')
              ? '../tests/' + file
              : '../web/' + file
        res.end(await readFile(new URL(path, import.meta.url)))
      } catch {
        res.writeHead(404).end()
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => {
      server.closeAllConnections()
      server.close()
    })
    const url = 'http://127.0.0.1:' + server.address().port
    const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
    let downloads = 0
    await page.route(DEPTH_MODEL.url, (route) => {
      downloads++
      return route.fulfill({
        status: 302,
        headers: { location: url + '/depth.onnx', 'access-control-allow-origin': '*' }
      })
    })
    await page.goto(url)
    await page.evaluate(async () => {
      const { run } = await import('./app.js')
      await run('import', {
        files: [
          new File([await (await fetch('./fixtures/ai/astronaut.png')).blob()], 'astronaut.png', {
            type: 'image/png'
          })
        ]
      })
      await run('view', { mode: 'detail' })
    })
    await page.getByText('Masks & local repair', { exact: true }).click()
    await page.getByRole('button', { name: 'Apply lens blur', exact: true }).click()
    await page.waitForFunction(async () =>
      (await import('./app.js')).run('state').then((s) => Boolean(s.photos[0].edit.localTools?.depth))
    )
    const first = await page.evaluate(async () => {
      const { run } = await import('./app.js'),
        { render } = await import('./render.js'),
        { sampleSoftMask } = await import('./soft-mask.js'),
        state = await run('state'),
        local = state.photos[0].edit.localTools,
        bitmap = await createImageBitmap(await (await fetch('./fixtures/ai/astronaut.png')).blob()),
        before = render(bitmap),
        after = render(bitmap, { localTools: local }),
        a = before.getContext('2d').getImageData(0, 0, 512, 512).data,
        b = after.getContext('2d').getImageData(0, 0, 512, 512).data
      let farDifference = 0,
        focusDifference = 0,
        focused = 0
      for (let y = 40; y < 180; y++)
        for (let x = 10; x < 490; x++) {
          const d = sampleSoftMask(local.depth.raster, (x + 0.5) / 512, (y + 0.5) / 512),
            i = (y * 512 + x) * 4,
            delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
          if (d < 0.1) farDifference += delta
          if (d > 0.23 && d < 0.4) {
            focusDifference += delta
            focused++
          }
        }
      bitmap.close()
      return {
        farDifference,
        focusDifference,
        focused,
        model: local.depth.provenance.model,
        metrics: local.depth.metrics
      }
    })
    assert.ok(first.farDifference > 100)
    assert.equal(first.focusDifference, 0)
    assert.ok(first.focused > 100)
    assert.equal(first.model, 'depth-anything-v2-small-quantized.onnx')
    await page.getByLabel('Range minimum', { exact: true }).fill('0.15')
    await page.getByLabel('Range maximum', { exact: true }).fill('0.5')
    await page.getByLabel('Range softness', { exact: true }).fill('0.01')
    await page.getByRole('button', { name: 'Create depth range', exact: true }).click()
    await page.waitForFunction(async () =>
      (await import('./app.js'))
        .run('state')
        .then((s) => s.photos[0].edit.localTools?.masks?.at(-1)?.type === 'depth-range')
    )
    const selected = await page.evaluate(async () => {
      const { run } = await import('./app.js'),
        { localWeight } = await import('./local-tools.js'),
        state = await run('state'),
        mask = state.photos[0].edit.localTools.masks[0]
      await run('lens-blur', { min: 0.8, max: 1 })
      return {
        person: localWeight(mask, 0.43, 0.25, 512, 512),
        background: localWeight(mask, 0.85, 0.1, 512, 512)
      }
    })
    assert.ok(selected.person > 0.9)
    assert.equal(selected.background, 0)
    await page.reload()
    await page.locator('#gallery .tile').waitFor()
    const reused = await page.evaluate(async () => {
      const { estimateDepth } = await import('./depth.js'),
        { decodeSoftMask } = await import('./soft-mask.js'),
        bitmap = await createImageBitmap(await (await fetch('./fixtures/ai/astronaut.png')).blob()),
        NativeWorker = window.Worker
      window.Worker = class {
        constructor() {
          throw Error('Simulated unavailable worker')
        }
      }
      try {
        const result = await estimateDepth(bitmap)
        return { count: decodeSoftMask(result.raster).length, model: result.provenance.model }
      } finally {
        window.Worker = NativeWorker
        bitmap.close()
      }
    })
    assert.equal(downloads, 1)
    assert.equal(reused.count, 518 * 518)
  }
)
