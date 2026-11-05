import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { chromium } from 'playwright-core'

const root = resolve('.')
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  try {
    const path = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname)
    if (path !== root && !path.startsWith(root + sep)) throw Error('Invalid path')
    if (path === root) {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><title>OpenLR codec validation</title>')
    } else {
      response.setHeader('Content-Type', extname(path) === '.wasm'
        ? 'application/wasm' : 'text/javascript')
      response.end(await readFile(path))
    }
  } catch {
    response.writeHead(404).end()
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
try {
  const records = []
  for (const [directory, name, threads, simd] of [
    ['build', 'jxl_color_enc', false, false],
    ['build-mt', 'jxl_color_enc_mt', true, false],
    ['build-mt-simd', 'jxl_color_enc_mt_simd', true, true]
  ]) {
    const page = await browser.newPage()
    let workers = 0
    page.on('worker', () => workers++)
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    const result = await page.evaluate(async ({ directory, name }) => {
      if (!crossOriginIsolated) throw Error('Actual thread test requires isolation')
      const { default: factory } = await import(`/.tools/codec-color/jxl/${directory}/${name}.js`)
      const { default: inspectorFactory } = await import('/.tools/codec-color/jxl/build/jxl_inspect.js')
      const { convertSrgbPixels, makeColorProfile } = await import('/web/color-spaces.js')
      const encoder = await factory(), inspector = await inspectorFactory()
      const width = 64, height = 48, data = new Uint8ClampedArray(width * height * 4)
      for (let i = 0; i < data.length; i += 4)
        data.set([(i * 3) % 256, (i * 7) % 256, (i * 11) % 256, (i / 4) % 256], i)
      const results = []
      for (const space of ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020']) {
        const target = convertSrgbPixels({ width, height, data }, space), profile = makeColorProfile(space)
        for (const lossless of [true, false]) {
          const encoded = encoder.encodeColor(target.data, width, height, profile,
            lossless ? 100 : 80, lossless, 7, space === 'srgb')
          if (!encoded) throw Error('Encoder rejected valid pixels/profile')
          const decoded = inspector.inspect(encoded)
          if (!decoded || decoded.width !== width || decoded.height !== height)
            throw Error('Real JXL decode failed')
          if (decoded.usesOriginalProfile !== (space !== 'srgb' || lossless))
            throw Error('Input/data profile contract mismatch')
          let maximum = 0
          if (lossless) for (let i = 0; i < data.length; i++)
            maximum = Math.max(maximum, Math.abs(target.data[i] - decoded.pixels[i]))
          if (lossless && maximum !== 0) throw Error('Lossless pixels/alpha changed')
          if (decoded.usesOriginalProfile &&
              (decoded.dataICC.length !== profile.length ||
              !profile.every((byte, i) => decoded.dataICC[i] === byte)))
            throw Error('Actual target data ICC changed')
          results.push({ space, lossless, bytes: encoded.length, maximum })
        }
      }
      return { features: encoder.buildFeatures(), results,
        experimentalApiExposed: typeof encoder.encodeColorExperiment === 'function' }
    }, { directory, name })
    assert.deepEqual(result.features, { encoderVersion: 7000, threads, simd })
    assert.equal(result.experimentalApiExposed, false, 'Production build must omit test-only control')
    if (threads) assert(workers > 0, 'No real pthread Workers started')
    records.push({ name, workers, ...result })
    await page.close()
  }
  const report = { browser: browser.version(), records }
  await writeFile('.tools/codec-color/jxl/browser-results.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
