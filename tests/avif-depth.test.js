import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { runAvifDepthExperiment } from '../scripts/experiments/avif-depth.mjs'

test('shipped AVIF WASM keeps source low bits, owned straight alpha and color metadata', async () => {
  const report = await runAvifDepthExperiment()
  assert.equal(report.rows.length, 18)
  for (const depth of [8, 10, 12]) {
    const sameDepth = report.rows.find((row) => row.sourceBitDepth === depth && row.bitDepth === depth)
    assert.equal(sameDepth.maxDifference, 0)
    const high = report.rows.find((row) => row.sourceBitDepth === depth && row.bitDepth === 16)
    assert.ok(high.maxDifference <= 1)
  }
})

test('AVIF adapter retains default byte decode and exposes explicit 16-bit integer decode', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const { default: createEncoder } = await import('./vendor/codecs/avif/codec/enc/avif_enc.js'),
      { defaultOptions } = await import('./vendor/codecs/avif/meta.js'),
      { decodeAvif } = await import('./color-codecs.js'),
      { makeColorProfile } = await import('./color-spaces.js'),
      encoder = await createEncoder(),
      icc = makeColorProfile('display-p3'),
      rows = []
    for (const depth of [10, 12]) {
      const width = 32,
        height = 16,
        max = 2 ** depth - 1,
        data = Uint16Array.from({ length: width * height * 4 }, (_, i) => i % (max + 1)),
        original = data.slice(),
        bytes = encoder.encode(new Uint8Array(data.buffer), width, height, {
          ...defaultOptions,
          quality: 100,
          subsample: 3,
          speed: 10,
          bitDepth: depth,
          icc,
          colorPrimaries: 12,
          transferCharacteristics: 13,
          matrixCoefficients: 0,
          fullRange: true
        }),
        source = bytes.slice(),
        legacy = await decodeAvif(bytes),
        high = await decodeAvif(bytes, 16)
      let maxDifference = 0
      for (let i = 0; i < data.length; i++)
        maxDifference = Math.max(maxDifference, Math.abs(high.data[i] - Math.round((data[i] * 65535) / max)))
      let invalid = false
      try {
        await decodeAvif(bytes, 9)
      } catch {
        invalid = true
      }
      rows.push({
        depth,
        legacyType: legacy.data.constructor.name,
        legacyDepth: legacy.bitDepth,
        highType: high.data.constructor.name,
        highDepth: high.bitDepth,
        sourceDepth: high.sourceBitDepth,
        dimensions: [high.width, high.height],
        maxDifference,
        invalid,
        color: [high.colorPrimaries, high.transferCharacteristics, high.matrixCoefficients, high.fullRange],
        profileSame: icc.every((v, i) => high.icc[i] === v) && high.icc.length === icc.length,
        sourceSame: source.every((v, i) => bytes[i] === v) && original.every((v, i) => data[i] === v)
      })
    }
    return rows
  })
  for (const row of result) {
    assert.equal(row.legacyType, 'Uint8ClampedArray')
    assert.equal(row.legacyDepth, 8)
    assert.equal(row.highType, 'Uint16Array')
    assert.equal(row.highDepth, 16)
    assert.equal(row.sourceDepth, row.depth)
    assert.deepEqual(row.dimensions, [32, 16])
    assert.ok(row.maxDifference <= 1)
    assert.deepEqual(row.color, [12, 13, 0, true])
    assert.equal(row.profileSame, true)
    assert.equal(row.sourceSame, true)
    assert.equal(row.invalid, true)
  }
})
