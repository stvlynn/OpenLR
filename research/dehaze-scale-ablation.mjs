// Research-only analysis-scale experiment; production remains unchanged.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import { analyzeDehaze } from '../web/dehaze.js'
import { readPng } from '../web/png.js'
import { convertPngPixels } from '../web/png-color.js'

const air = [0.85, 0.9, 1]
const frame = (width, height, data = new Float32Array(width * height * 4)) => ({
  width,
  height,
  data,
  colorSpace: 'srgb-linear'
})
function areaProxy(input, edge) {
  const factor = Math.min(1, edge / Math.max(input.width, input.height))
  const output = frame(
    Math.max(1, Math.round(input.width * factor)),
    Math.max(1, Math.round(input.height * factor))
  )
  const sx = input.width / output.width,
    sy = input.height / output.height
  for (let y = 0; y < output.height; y++)
    for (let x = 0; x < output.width; x++) {
      const x0 = x * sx,
        x1 = (x + 1) * sx,
        y0 = y * sy,
        y1 = (y + 1) * sy
      let alpha = 0,
        red = 0,
        green = 0,
        blue = 0
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++)
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const weight = (Math.min(x1, xx + 1) - Math.max(x0, xx)) * (Math.min(y1, yy + 1) - Math.max(y0, yy))
          const at = (yy * input.width + xx) * 4,
            coverage = weight * input.data[at + 3]
          alpha += coverage
          if (coverage) {
            red += input.data[at] * coverage
            green += input.data[at + 1] * coverage
            blue += input.data[at + 2] * coverage
          }
        }
      const at = (y * output.width + x) * 4
      output.data[at] = alpha ? red / alpha : 0
      output.data[at + 1] = alpha ? green / alpha : 0
      output.data[at + 2] = alpha ? blue / alpha : 0
      output.data[at + 3] = Math.min(1, alpha / (sx * sy))
    }
  return output
}
function scalarSample(values, width, height, x, y) {
  x = Math.max(0, Math.min(width - 1, x))
  y = Math.max(0, Math.min(height - 1, y))
  const left = Math.floor(x),
    top = Math.floor(y),
    right = Math.min(width - 1, left + 1),
    bottom = Math.min(height - 1, top + 1)
  const fx = x - left,
    fy = y - top
  return (
    (values[top * width + left] * (1 - fx) + values[top * width + right] * fx) * (1 - fy) +
    (values[bottom * width + left] * (1 - fx) + values[bottom * width + right] * fx) * fy
  )
}
function transmissionAt(map, width, height, x, y) {
  return scalarSample(
    map.transmission,
    map.width,
    map.height,
    ((x + 0.5) * map.width) / width - 0.5,
    ((y + 0.5) * map.height) / height - 0.5
  )
}
function generated(width, height, spacing) {
  const clear = frame(width, height),
    observed = frame(width, height),
    strip = 32
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4,
        t = x < width / 2 ? 0.35 : 0.8
      for (let c = 0; c < 3; c++) {
        const value =
          y < strip
            ? air[c]
            : x % spacing === 0 && y % spacing === 0
              ? 0
              : 0.05 + 0.65 * ((x / width + y / height + c * 0.2) % 1)
        clear.data[at + c] = value
        observed.data[at + c] = y < strip ? air[c] : value * t + air[c] * (1 - t)
      }
      clear.data[at + 3] = observed.data[at + 3] = 1
    }
  return { clear, observed, strip }
}
function photographic(input, size) {
  const clear = frame(size, size),
    observed = frame(size, size)
  const planes = [0, 1, 2].map((c) =>
    Float32Array.from({ length: input.width * input.height }, (_, i) => input.data[i * 4 + c])
  )
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4,
        t = x < size / 2 ? 0.35 : 0.8
      for (let c = 0; c < 3; c++) {
        const value = scalarSample(
          planes[c],
          input.width,
          input.height,
          ((x + 0.5) * input.width) / size - 0.5,
          ((y + 0.5) * input.height) / size - 0.5
        )
        clear.data[at + c] = value
        observed.data[at + c] = value * t + air[c] * (1 - t)
      }
      clear.data[at + 3] = observed.data[at + 3] = 1
    }
  return { clear, observed, strip: 0 }
}
function metrics(scene, map, reference) {
  const { observed, clear, strip } = scene,
    { width, height } = observed
  let targetSquared = 0,
    targetEdgeSquared = 0,
    exactSquared = 0,
    exactAbsolute = 0,
    exactMaximum = 0,
    edgeExactSquared = 0,
    samples = 0,
    edgeSamples = 0,
    mapMax = 0,
    outside = 0
  for (let y = strip; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = y * width + x,
        at = index * 4
      if (!observed.data[at + 3]) continue
      const t = transmissionAt(map, width, height, x, y),
        refT = reference.transmission[index],
        edge = Math.abs(x - width / 2) <= 8
      mapMax = Math.max(mapMax, Math.abs(t - refT))
      for (let c = 0; c < 3; c++) {
        const value = map.airlight[c] + (observed.data[at + c] - map.airlight[c]) / t
        const ref = reference.airlight[c] + (observed.data[at + c] - reference.airlight[c]) / refT
        const targetError = value - clear.data[at + c],
          exactError = value - ref
        targetSquared += targetError * targetError
        exactSquared += exactError * exactError
        exactAbsolute += Math.abs(exactError)
        exactMaximum = Math.max(exactMaximum, Math.abs(exactError))
        if (value < 0 || value > 1) outside++
        samples++
        if (edge) {
          targetEdgeSquared += targetError * targetError
          edgeExactSquared += exactError * exactError
          edgeSamples++
        }
      }
    }
  return {
    targetMse: targetSquared / samples,
    targetEdgeMse: targetEdgeSquared / edgeSamples,
    exactMse: exactSquared / samples,
    exactMae: exactAbsolute / samples,
    exactMaximum,
    edgeExactMse: edgeExactSquared / edgeSamples,
    transmissionMaximumError: mapMax,
    outsideDisplayFraction: outside / samples
  }
}
const output = {
  environment: { node: process.version, platform: process.platform, cpu: os.cpus()[0].model },
  amount: 100,
  cases: []
}
const astronaut = convertPngPixels(
  readPng(await readFile(new URL('../tests/fixtures/ai/astronaut.png', import.meta.url)))
).frame
for (const [name, build] of [
  ['fine-anchors-3', () => generated(3072, 2048, 3)],
  ['sparse-anchors-17', () => generated(3072, 2048, 17)],
  ['upscaled-astronaut-with-synthetic-veil', () => photographic(astronaut, 3072)]
]) {
  const scene = build(),
    start = performance.now(),
    exact = analyzeDehaze(scene.observed)
  const result = {
    name,
    width: scene.observed.width,
    height: scene.observed.height,
    variants: [
      {
        edge: 'exact',
        totalMs: performance.now() - start,
        airlight: exact.airlight,
        ...metrics(scene, exact, exact)
      }
    ]
  }
  for (const edge of [512, 1024, 2048]) {
    const start = performance.now(),
      proxy = areaProxy(scene.observed, edge),
      proxyMs = performance.now() - start
    const analysisStart = performance.now(),
      map = analyzeDehaze(proxy),
      analyzeMs = performance.now() - analysisStart
    result.variants.push({
      edge,
      proxyWidth: proxy.width,
      proxyHeight: proxy.height,
      totalMs: proxyMs + analyzeMs,
      proxyMs,
      analyzeMs,
      airlight: map.airlight,
      ...metrics(scene, map, exact)
    })
  }
  output.cases.push(result)
  console.log(JSON.stringify(result))
  global.gc?.()
}
// Identical visible samples and alpha, with incompatible hidden payloads.
const transparent = frame(96, 64)
for (let i = 0; i < 96 * 64; i++) {
  const at = i * 4,
    alpha = i % 5 ? 0.4 : 0
  transparent.data.set([alpha ? 0.3 : 1e20, alpha ? 0.5 : -1e20, alpha ? 0.7 : 0.9, alpha], at)
}
const changedHidden = { ...transparent, data: transparent.data.slice() }
for (let i = 0; i < changedHidden.data.length; i += 4)
  if (!changedHidden.data[i + 3]) changedHidden.data.set([-10, 50, 0], i)
const a = areaProxy(transparent, 32),
  b = areaProxy(changedHidden, 32)
assert.deepEqual(a.data, b.data)
const mapA = analyzeDehaze(a),
  mapB = analyzeDehaze(b)
assert.deepEqual(mapA.airlight, mapB.airlight)
assert.deepEqual(mapA.transmission, mapB.transmission)
output.hiddenRgbInvariant = true
await mkdir('.workspace', { recursive: true })
await writeFile('.workspace/dehaze-scale-ablation.json', JSON.stringify(output, null, 2))
console.log(
  JSON.stringify({
    hiddenRgbInvariant: output.hiddenRgbInvariant,
    artifact: '.workspace/dehaze-scale-ablation.json'
  })
)
