import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { parse } from '../cli/openlr.mjs'
import { ENHANCE_MODELS } from '../web/enhance-models.js'
test('enhance CLI describes actual neural raster operations and validates strength', () => {
  assert.equal(parse(['enhance', '--mode', 'denoise', '--strength', '0.5', '--dry-run']).args.strength, 0.5)
  assert.throws(() => parse(['enhance', '--mode', 'raw-ai', '--dry-run']), /one of/)
  assert.throws(() => parse(['enhance', '--strength', '2', '--dry-run']), /valid range/)
})
let available = true
for (const name of ['oidn-rt-ldr-small.onnx', 'espcn-x3.onnx'])
  try {
    await stat(new URL('../.tools/ai-models/' + name, import.meta.url))
  } catch {
    available = false
  }
test(
  'actual denoise/super-resolution models create derived PNGs through UI/CLI, cache and fallback',
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
        const path = file.startsWith('weights/')
          ? '../.tools/ai-models/' + file.slice(8)
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
    const url = 'http://127.0.0.1:' + server.address().port,
      browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }),
      downloads = {}
    for (const model of Object.values(ENHANCE_MODELS))
      await page.route(model.url, (route) => {
        downloads[model.id] = (downloads[model.id] ?? 0) + 1
        return route.fulfill({
          status: 302,
          headers: { location: url + '/weights/' + model.file, 'access-control-allow-origin': '*' }
        })
      })
    await page.goto(url)
    const originalId = await page.evaluate(async () => {
      const { run } = await import('./app.js'),
        image = await createImageBitmap(await (await fetch('./fixtures/ai/astronaut.png')).blob()),
        c = document.createElement('canvas')
      c.width = c.height = 96
      const ctx = c.getContext('2d')
      ctx.drawImage(image, 160, 40, 192, 192, 0, 0, 96, 96)
      image.close()
      window.__clean = ctx.getImageData(0, 0, 96, 96).data.slice()
      const pixels = ctx.getImageData(0, 0, 96, 96)
      let seed = 42
      const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) + 0.5) / 4294967296
      for (let i = 0; i < pixels.data.length; i++)
        if (i % 4 !== 3)
          pixels.data[i] += 15 * Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random())
      ctx.putImageData(pixels, 0, 0)
      const file = new File([await new Promise((resolve) => c.toBlob(resolve))], 'noisy.png', {
        type: 'image/png'
      })
      window.__originalBytes = new Uint8Array(await file.arrayBuffer())
      await run('import', { files: [file] })
      await run('view', { mode: 'detail' })
      return (await run('state')).selected
    })
    await page.getByRole('button', { name: 'Enhance / Denoise', exact: true }).click()
    await page.getByLabel('Enhance mode', { exact: true }).selectOption('denoise')
    await page.getByRole('button', { name: 'Create enhanced copy', exact: true }).click()
    await page.waitForFunction(async () =>
      (await import('./app.js')).run('state').then((s) => s.photos.length === 2)
    )
    const first = await page.evaluate(async (originalId) => {
      const { run } = await import('./app.js'),
        state = await run('state'),
        derived = state.photos.find((p) => p.id === state.selected),
        read = async (blob) => {
          const bitmap = await createImageBitmap(blob),
            c = document.createElement('canvas')
          c.width = bitmap.width
          c.height = bitmap.height
          const ctx = c.getContext('2d')
          ctx.drawImage(bitmap, 0, 0)
          bitmap.close()
          return ctx.getImageData(0, 0, c.width, c.height).data
        },
        output = await read((await run('export', { format: 'original' })).blob)
      await run('select', { id: originalId })
      const original = (await run('export', { format: 'original' })).blob,
        bytes = new Uint8Array(await original.arrayBuffer()),
        input = await read(original),
        mse = (data) => {
          let error = 0,
            n = 0
          for (let i = 0; i < data.length; i++)
            if (i % 4 !== 3) {
              error += (data[i] - window.__clean[i]) ** 2
              n++
            }
          return error / n
        }
      return {
        derived,
        sourceUnchanged: bytes.every((v, i) => v === window.__originalBytes[i]),
        inputMse: mse(input),
        outputMse: mse(output)
      }
    }, originalId)
    assert.equal(first.derived.width, 96)
    assert.equal(first.derived.height, 96)
    assert.equal(first.derived.enhance.model, 'oidn-rt-ldr-small')
    assert.equal(first.derived.enhance.sourceId, originalId)
    assert.equal(first.sourceUnchanged, true)
    assert.ok(first.outputMse < first.inputMse * 0.7)
    const superres = await page.evaluate(async () => {
      const { run } = await import('./app.js'),
        NativeWorker = window.Worker
      await run('edit', { key: 'Exposure', value: 0.25 })
      window.Worker = class {
        constructor() {
          throw Error('Simulated Worker startup failure')
        }
      }
      try {
        return await run('enhance', { mode: 'super-resolution' })
      } finally {
        window.Worker = NativeWorker
      }
    })
    assert.equal(superres.width, 288)
    assert.equal(superres.height, 288)
    assert.equal(superres.enhance.model, 'espcn-x3')
    assert.match(superres.enhance.sourceTransfer, /not sensor RAW/)
    assert.equal(superres.enhance.sourceEdit.Exposure, 0.25)
    await page.reload()
    await page.locator('#gallery .tile').first().waitFor()
    await page.evaluate(async (originalId) => {
      const { run } = await import('./app.js')
      await run('select', { id: originalId })
      await run('enhance', { mode: 'denoise', strength: 0.5 })
    }, originalId)
    assert.equal(downloads['oidn-rt-ldr-small'], 1)
    assert.equal(downloads['espcn-x3'], 1)
  }
)
