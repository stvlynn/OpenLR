// Generated fixtures exercise the shipped encoder/decoder WASM; no external image assets.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { makeColorProfile } from '../../web/color-spaces.js'
import { defaultOptions } from '../../web/vendor/codecs/avif/meta.js'

const workspace = fileURLToPath(new URL('../../', import.meta.url))
async function load(path) {
  const file = resolve(workspace, path)
  const { default: factory } = await import(pathToFileURL(file))
  return factory({ wasmBinary: await readFile(file.replace(/\.js$/, '.wasm')) })
}
export async function runAvifDepthExperiment({ outputDir } = {}) {
  const dir = outputDir && resolve(outputDir)
  if (dir) await mkdir(dir, { recursive: true })
  const encoder = await load('web/vendor/codecs/avif/codec/enc/avif_enc.js')
  const decoder = await load('web/vendor/codecs/avif/codec/dec/avif_dec.js')
  const width = 64,
    height = 64,
    icc = makeColorProfile('display-p3'),
    rows = []
  function boxes(bytes, start = 0, end = bytes.length, found = []) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let offset = start; offset < end;) {
      const size = view.getUint32(offset),
        kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
      assert.ok(size >= 8 && offset + size <= end)
      found.push({ offset, size, kind })
      if (['meta', 'iprp', 'ipco', 'iref'].includes(kind))
        boxes(bytes, offset + (['meta', 'iref'].includes(kind) ? 12 : 8), offset + size, found)
      offset += size
    }
    return found
  }
  // Controlled fixture-only BMFF patch: add prem(color -> alpha); shift iloc offsets.
  function premultiplied(bytes) {
    const all = boxes(bytes),
      meta = all.find((b) => b.kind === 'meta'),
      iref = all.find((b) => b.kind === 'iref'),
      iloc = all.find((b) => b.kind === 'iloc'),
      auxl = all.find((b) => b.kind === 'auxl')
    assert.ok(meta && iref && iloc && auxl)
    const old = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const alphaID = old.getUint16(auxl.offset + 8),
      colorID = old.getUint16(auxl.offset + 12)
    const insert = iref.offset + iref.size,
      out = new Uint8Array(bytes.length + 14),
      view = new DataView(out.buffer)
    out.set(bytes.subarray(0, insert))
    out.set(bytes.subarray(insert), insert + 14)
    view.setUint32(insert, 14)
    out.set(new TextEncoder().encode('prem'), insert + 4)
    view.setUint16(insert + 8, colorID)
    view.setUint16(insert + 10, 1)
    view.setUint16(insert + 12, alphaID)
    view.setUint32(meta.offset, meta.size + 14)
    view.setUint32(iref.offset, iref.size + 14)
    const base = iloc.offset + (iloc.offset >= insert ? 14 : 0)
    assert.equal(view.getUint32(base + 8), 0)
    assert.equal(view.getUint16(base + 12), 0x4400)
    const count = view.getUint16(base + 14)
    for (let i = 0, pos = base + 16; i < count; i++) {
      pos += 4
      const extents = view.getUint16(pos)
      pos += 2
      for (let j = 0; j < extents; j++, pos += 8) view.setUint32(pos, view.getUint32(pos) + 14)
    }
    return out
  }
  for (const depth of [8, 10, 12]) {
    const max = 2 ** depth - 1
    const data = depth === 8 ? new Uint8Array(width * height * 4) : new Uint16Array(width * height * 4)
    for (let p = 0; p < width * height; p++) {
      data.set(
        [
          p % (max + 1),
          (p * 37 + 1) % (max + 1),
          (p * 71 + 2) % (max + 1),
          p % 5 === 0 ? 0 : p % 5 === 1 ? 1 : p % 5 === 2 ? max : (p * 19) % (max + 1)
        ],
        p * 4
      )
    }
    data.set([0, 1, 2, max, max, max - 1, max - 2, 0], 0)
    const originalSamples = data.slice()
    const bytes = encoder.encode(new Uint8Array(data.buffer), width, height, {
      ...defaultOptions,
      quality: 100,
      qualityAlpha: -1,
      subsample: 3,
      speed: 10,
      bitDepth: depth,
      icc,
      colorPrimaries: 12,
      transferCharacteristics: 13,
      matrixCoefficients: 0,
      fullRange: true
    })
    assert.ok(bytes?.length)
    const originalBytes = bytes.slice()
    const pixi = boxes(bytes)
      .filter((b) => b.kind === 'pixi')
      .map((b) => Array.from(bytes.subarray(b.offset + 13, b.offset + b.size)))
    assert.ok(pixi.length >= 2)
    assert.ok(
      pixi.every((channels) => channels.length > 0 && channels.every((bits) => bits === depth)),
      'actual BMFF pixi source depth'
    )
    if (dir) await writeFile(resolve(dir, `rgba${depth}.avif`), bytes)
    const same = decoder.decodeWithColor(bytes, depth)
    assert.deepEqual(
      Array.from(same.data),
      Array.from(data),
      'exact source-depth RGBA incl. nonzero RGB beneath zero alpha'
    )
    for (const requested of [8, 10, 12, 16]) {
      const decoded = decoder.decodeWithColor(bytes, requested)
      assert.equal(decoded.data.constructor.name, requested === 8 ? 'Uint8ClampedArray' : 'Uint16Array')
      assert.equal(decoded.width, width)
      assert.equal(decoded.height, height)
      assert.equal(decoded.bitDepth, requested)
      assert.equal(decoded.sourceBitDepth, depth)
      assert.deepEqual(decoded.icc, icc)
      assert.deepEqual(
        [
          decoded.colorPrimaries,
          decoded.transferCharacteristics,
          decoded.matrixCoefficients,
          decoded.fullRange
        ],
        [12, 13, 0, true]
      )
      const expected = Array.from(data, (value) => Math.round((value * (2 ** requested - 1)) / max))
      let maxDiff = 0
      for (let i = 0; i < expected.length; i++)
        maxDiff = Math.max(maxDiff, Math.abs(decoded.data[i] - expected[i]))
      assert.ok(
        maxDiff <= 1,
        'full-range rescaling differs by at most one output code due to native float rounding'
      )
      rows.push({
        sourceBitDepth: depth,
        bitDepth: requested,
        bytes: bytes.length,
        maxDifference: maxDiff,
        firstTwoPixels: Array.from(decoded.data.slice(0, 8))
      })
    }
    assert.equal(decoder.decodeWithColor(bytes, 9), null)
    const prem = premultiplied(bytes)
    const straight = decoder.decodeWithColor(prem, 16)
    assert.ok(straight)
    let premMaxDiff = 0
    for (let i = 0; i < data.length; i++) {
      const a = data[(i >> 2) * 4 + 3]
      const expected =
        i % 4 === 3 ? Math.round((a * 65535) / max) : a ? Math.round(Math.min(data[i] / a, 1) * 65535) : 0
      premMaxDiff = Math.max(premMaxDiff, Math.abs(straight.data[i] - expected))
    }
    assert.ok(premMaxDiff <= 1)
    if (dir) await writeFile(resolve(dir, `prem${depth}.avif`), prem)
    rows.push({ sourceBitDepth: depth, bitDepth: 16, premultiplied: true, maxDifference: premMaxDiff, pixi })
    assert.deepEqual(data, originalSamples, 'source samples unchanged by encoding')
    assert.deepEqual(bytes, originalBytes, 'source bytes unchanged by all decode requests')
    assert.deepEqual(
      Array.from(same.data),
      Array.from(originalSamples),
      'owned decoder samples survive subsequent decodes'
    )
    assert.deepEqual(same.icc, icc, 'owned ICC survives subsequent decodes')
  }
  assert.equal(decoder.decodeWithColor(Uint8Array.of(1, 2, 3), 16), null)
  for (const [cp, tc] of [
    [1, 13],
    [9, 16],
    [9, 18]
  ]) {
    const data = Uint16Array.from({ length: width * height * 4 }, (_, i) => (i % 4 === 3 ? 1023 : i % 1024))
    const bytes = encoder.encode(new Uint8Array(data.buffer), width, height, {
      ...defaultOptions,
      quality: 100,
      subsample: 3,
      speed: 10,
      bitDepth: 10,
      icc: new Uint8Array(),
      colorPrimaries: cp,
      transferCharacteristics: tc,
      matrixCoefficients: 0,
      fullRange: true
    })
    const decoded = decoder.decodeWithColor(bytes, 16)
    assert.equal(decoded.icc.length, 0)
    assert.deepEqual([decoded.colorPrimaries, decoded.transferCharacteristics], [cp, tc])
    const maxDiff = Math.max(
      ...Array.from(decoded.data, (v, i) => Math.abs(v - Math.round((data[i] * 65535) / 1023)))
    )
    assert.ok(maxDiff <= 1)
    rows.push({
      sourceBitDepth: 10,
      bitDepth: 16,
      noIcc: true,
      colorPrimaries: cp,
      transferCharacteristics: tc,
      maxDifference: maxDiff
    })
  }
  const report = {
    node: process.version,
    platform: process.platform,
    dimensions: [width, height],
    iccBytes: icc.length,
    rows
  }
  if (dir) await writeFile(resolve(dir, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(
    JSON.stringify(
      await runAvifDepthExperiment({ outputDir: resolve(workspace, '.workspace/high-depth-avif') }),
      null,
      2
    )
  )
}
