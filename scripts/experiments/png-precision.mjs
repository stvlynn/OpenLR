// Original generated PNG16 precision ablation; no outside photographic fixture.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { chromium } from 'playwright-core'
import { readPng } from '../../web/png.js'
import { makePngFixture } from '../../tests/fixtures/png.mjs'
import { serveWorkspace } from '../../tests/browser-server.mjs'

const width = 512,
  height = 2
const samples = Array.from({ length: width * height }, (_, i) => [
  1000 + (i % 512),
  2000 + (i % 512),
  3000 + (i % 512)
]).flat()
const { bytes } = makePngFixture({ width, height, colorType: 2, bits: 16, data: samples, srgb: 0 })
// Independent filter-zero reference: Node zlib and explicit big-endian words.
const idat = [],
  view = new DataView(bytes.buffer)
for (let at = 8; at < bytes.length;) {
  const length = view.getUint32(at),
    type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
  if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length))
  at += length + 12
}
const inflated = inflateSync(Buffer.concat(idat)),
  raw = new DataView(inflated.buffer, inflated.byteOffset, inflated.byteLength)
const independentWords = []
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) independentWords.push(raw.getUint16(y * (width * 6 + 1) + 1 + x * 6))
const decoded = readPng(bytes),
  nativeWords = Array.from(
    decoded.data.filter((_, i) => i % 4 === 0),
    (value) => Math.round(value * 65535)
  )
assert.deepEqual(nativeWords, independentWords)
const report = {
  width,
  height,
  sourceDepth: 16,
  sourceDistinctRed: new Set(independentWords).size,
  numericDistinctRed: new Set(nativeWords).size,
  maximumWordError: Math.max(...nativeWords.map((value, i) => Math.abs(value - independentWords[i]))),
  display: { status: 'not-run', command: 'node scripts/experiments/png-precision.mjs --browser' }
}
if (process.argv.includes('--browser')) {
  const server = await serveWorkspace(),
    browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(server.url)
    const display = await page.evaluate(async (input) => {
      const bitmap = await createImageBitmap(
          new File([Uint8Array.from(input)], 'ramp16.png', { type: 'image/png' })
        ),
        canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      return {
        status: 'measured',
        distinctRed: new Set(pixels.filter((_, i) => i % 4 === 0)).size,
        first: Array.from(pixels.slice(0, 16))
      }
    }, Array.from(bytes))
    assert.ok(display.distinctRed < report.numericDistinctRed)
    report.display = { ...display, browser: browser.version() }
  } finally {
    await browser.close()
    await server.close()
  }
}
await mkdir('.workspace/png-precision', { recursive: true })
await writeFile('.workspace/png-precision/ramp16.png', bytes)
await writeFile('.workspace/png-precision/report.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
