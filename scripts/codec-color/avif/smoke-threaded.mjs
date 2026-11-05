// Real Chrome pthread encoder proof with COOP/COEP and a ready worker pool.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const work = process.env.OPENLR_AVIF_BUILD_DIR || resolve(workspace, '.tools/codec-color/avif')
const server = createServer(async (req, res) => {
  try {
    const route = new URL(req.url, 'http://localhost').pathname
    const fixed = {
      '/colors.js': join(workspace, 'web/color-spaces.js'),
      '/meta.js': join(workspace, 'node_modules/@jsquash/avif/meta.js')
    }
    const asset =
      fixed[route] || (/^\/(enc|dec)\/[\w.]+$/.test(route) && join(work, 'output', route.slice(1)))
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    if (route === '/') {
      res.setHeader('Content-Type', 'text/html')
      res.end('<!doctype html><title>AVIF threaded binding proof</title>')
      return
    }
    if (!asset) {
      res.writeHead(404).end()
      return
    }
    res.setHeader('Content-Type', route.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
    res.end(await readFile(asset))
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
const deadline = setTimeout(() => {
  browser.close()
}, 60000)
try {
  const page = await browser.newPage()
  const diagnostics = []
  page.on('pageerror', (error) => diagnostics.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const result = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error('Missing cross-origin isolation')
    const [{ default: encoderFactory }, { default: decoderFactory }, colors, { defaultOptions }] =
      await Promise.all([
        import('/enc/avif_enc_mt.js'),
        import('/dec/avif_dec.js'),
        import('/colors.js'),
        import('/meta.js')
      ])
    const [encoder, decoder] = await Promise.all([encoderFactory(), decoderFactory()])
    const source = {
      width: 32,
      height: 24,
      data: Uint8ClampedArray.from({ length: 32 * 24 * 4 }, (_, i) => (i * 41 + (i >> 2) * 13) % 256)
    }
    const records = []
    for (const target of ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020']) {
      const converted = colors.convertSrgbPixels(source, target),
        icc = colors.makeColorProfile(target)
      const bytes = encoder.encode(new Uint8Array(converted.data.buffer), source.width, source.height, {
        ...defaultOptions,
        quality: 100,
        qualityAlpha: -1,
        subsample: 3,
        speed: 10,
        icc,
        colorPrimaries: 2,
        transferCharacteristics: 2,
        matrixCoefficients: -1,
        fullRange: true
      })
      const decoded = decoder.decodeWithColor(bytes, 8)
      if (!decoded) throw new Error(`${target}: decode failed`)
      let maxError = 0
      decoded.data.forEach((value, index) => {
        maxError = Math.max(maxError, Math.abs(value - converted.data[index]))
      })
      if (decoded.icc.length !== icc.length || decoded.icc.some((value, index) => value !== icc[index]))
        throw new Error(`${target}: ICC differs`)
      records.push({
        target,
        bytes: bytes.length,
        maxError,
        primaries: decoded.colorPrimaries,
        transfer: decoded.transferCharacteristics,
        matrix: decoded.matrixCoefficients,
        fullRange: decoded.fullRange
      })
    }
    return { isolated: crossOriginIsolated, userAgent: navigator.userAgent, records }
  })
  assert.deepEqual(diagnostics, [])
  assert.ok(result.isolated)
  for (const record of result.records) {
    assert.equal(record.maxError, 0)
    assert.deepEqual([record.primaries, record.transfer, record.matrix, record.fullRange], [2, 2, 0, true])
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  clearTimeout(deadline)
  await browser.close()
  server.closeAllConnections()
  server.close()
}
