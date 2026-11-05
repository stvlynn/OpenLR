import { spatialEffectsFloat } from '../web/color.js'
import { applyFrameOutputSharpening } from '../web/output-sharpening.js'
import { writeFile, mkdir } from 'node:fs/promises'
const W = 128,
  H = 64,
  L = [0.2126, 0.7152, 0.0722]
function image(fn) {
  const data = new Float32Array(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(fn(x, y), (y * W + x) * 4)
  return data
}
function gaussian(src, sigma = 0.65) {
  const r = Math.ceil(3 * sigma),
    k = Float64Array.from({ length: r * 2 + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma))),
    sum = k.reduce((a, b) => a + b, 0)
  for (let i = 0; i < k.length; i++) k[i] /= sum
  const temp = new Float64Array(W * H),
    out = new Float64Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let i = -r; i <= r; i++)
        temp[y * W + x] += src[y * W + Math.max(0, Math.min(W - 1, x + i))] * k[i + r]
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let i = -r; i <= r; i++)
        out[y * W + x] += temp[Math.max(0, Math.min(H - 1, y + i)) * W + x] * k[i + r]
  return out
}
function lumaUsm(data, amount, limit = Infinity) {
  const y = new Float64Array(W * H),
    a = new Float64Array(W * H)
  for (let p = 0; p < y.length; p++) {
    a[p] = data[p * 4 + 3]
    y[p] = (data[p * 4] * L[0] + data[p * 4 + 1] * L[1] + data[p * 4 + 2] * L[2]) * a[p]
  }
  const b = gaussian(y),
    weights = gaussian(a)
  for (let p = 0; p < y.length; p++)
    if (a[p] > 0 && weights[p] > 0) {
      const delta = Math.max(-limit, Math.min(limit, amount * (y[p] / a[p] - b[p] / weights[p])))
      for (let c = 0; c < 3; c++) data[p * 4 + c] += delta
    }
}
function blurRgb(data) {
  const out = data.slice()
  for (let c = 0; c < 3; c++) {
    const b = gaussian(
      Float64Array.from({ length: W * H }, (_, p) => data[p * 4 + c]),
      0.8
    )
    for (let p = 0; p < b.length; p++) out[p * 4 + c] = b[p]
  }
  return out
}
const truth = image((x, y) => {
    const v =
      0.35 +
      0.12 * Math.sin((2 * Math.PI * x) / 13) +
      0.06 * Math.sin((2 * Math.PI * y) / 7) +
      (x > 64 ? 0.18 : 0)
    return [v, v, v, 1]
  }),
  blurred = blurRgb(truth)
const step = image((x) => [x < 64 ? 0.2 : 0.7, x < 64 ? 0.2 : 0.7, x < 64 ? 0.2 : 0.7, 1]),
  stepBlur = blurRgb(step)
let seed = 12345
const noise = image(() => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  const v = 0.4 + ((seed >>> 0) / 4294967296 - 0.5) * 0.008
  return [v, v, v, 1]
})
const first = [0.75, 0.055, 0.02],
  Y = first.reduce((a, v, c) => a + v * L[c], 0),
  second = [0.04, (Y - 0.04 * L[0] - 0.05 * L[2]) / L[1], 0.05]
const chroma = image((x) => [...(x < 64 ? first : second), 1])
const alpha = image((x) => (x < 64 ? [100, -50, 10, 0] : [0.45, 0.2, 0.1, (x - 63) / 64]))
const hdr = image((x, y) => [1.5 + x * 0.001, -0.1 - y * 0.0001, 0.3, 1])
const variants = [
  ['off', () => {}],
  ...[10, 20, 35].map((v) => ['existing-' + v, (d) => spatialEffectsFloat(d, W, H, { Sharpening: v })]),
  ...[0.3, 0.6, 1].map((v) => ['luma-usm-' + v, (d) => lumaUsm(d, v)]),
  ...[0.3, 0.6, 1].map((v) => ['luma-usm-limited-' + v, (d) => lumaUsm(d, v, 0.025)]),
  ...[0.3, 0.6, 1].map((v) => ['luma-scaled-limit025-' + v, (d) => lumaUsm(d, v, 0.025 * v)]),
  ...[0.3, 0.6, 1].map((v) => ['luma-scaled-limit015-' + v, (d) => lumaUsm(d, v, 0.015 * v)])
]
const mse = (a, b) => {
  let v = 0
  for (let p = 0; p < W * H; p++) for (let c = 0; c < 3; c++) v += (a[p * 4 + c] - b[p * 4 + c]) ** 2
  return v / (W * H * 3)
}
for (const level of ['low', 'standard', 'high'])
  variants.push([
    'production-' + level,
    (d) => applyFrameOutputSharpening({ width: W, height: H, data: d, colorSpace: 'srgb-linear' }, level)
  ])
const std = (d) => {
  const v = Array.from({ length: W * H }, (_, p) => d[p * 4]),
    mean = v.reduce((a, b) => a + b, 0) / v.length
  return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length)
}
function run(input, filter) {
  const d = input.slice()
  filter(d)
  return d
}
const result = []
for (const [name, filter] of variants) {
  const output = run(blurred, filter),
    edge = run(stepBlur, filter),
    hard = run(step, filter),
    n = run(noise, filter),
    c = run(chroma, filter),
    a = run(alpha, filter),
    h = run(hdr, filter)
  let maxLumaShift = 0,
    maxChromaShift = 0,
    visibleDrift = 0,
    hiddenDrift = 0,
    alphaDrift = 0,
    min = Infinity,
    max = -Infinity,
    hardHalo = 0
  for (let p = 0; p < W * H; p++) {
    let shift = 0
    for (let k = 0; k < 3; k++) {
      shift += (c[p * 4 + k] - chroma[p * 4 + k]) * L[k]
      const drift = Math.abs(a[p * 4 + k] - alpha[p * 4 + k])
      if (alpha[p * 4 + 3]) visibleDrift = Math.max(visibleDrift, drift)
      else hiddenDrift = Math.max(hiddenDrift, drift)
      min = Math.min(min, edge[p * 4 + k])
      max = Math.max(max, edge[p * 4 + k])
      hardHalo = Math.max(hardHalo, 0.2 - hard[p * 4 + k], hard[p * 4 + k] - 0.7)
    }
    maxLumaShift = Math.max(maxLumaShift, Math.abs(shift))
    maxChromaShift = Math.max(
      maxChromaShift,
      Math.abs(c[p * 4] - c[p * 4 + 1] - (chroma[p * 4] - chroma[p * 4 + 1]))
    )
    alphaDrift = Math.max(alphaDrift, Math.abs(a[p * 4 + 3] - alpha[p * 4 + 3]))
  }
  result.push({
    name,
    mseToTruth: mse(output, truth),
    edgeContrast: edge[(32 * W + 64) * 4] - edge[(32 * W + 63) * 4],
    undershoot: Math.max(0, 0.2 - min),
    overshoot: Math.max(0, max - 0.7),
    hardHalo,
    noiseAmplification: std(n) / std(noise),
    maxLumaShift,
    maxChromaShift,
    visibleDrift,
    hiddenDrift,
    alphaDrift,
    hdrFinite: h.every(Number.isFinite),
    hdrRetainsAboveOne: h.some((v) => v > 1),
    hdrRetainsNegative: h.some((v) => v < 0)
  })
}
await mkdir(new URL('../.workspace/', import.meta.url), { recursive: true })
await writeFile(
  new URL('../.workspace/output-sharpen-ablation.json', import.meta.url),
  JSON.stringify(
    { width: W, height: H, blurSigma: 0.8, sharpenSigma: 0.65, selectedResidualScale: 0.015, result },
    null,
    2
  )
)
console.table(
  result.map((r) =>
    Object.fromEntries(
      Object.entries(r)
        .filter(
          ([k]) =>
            ![
              'hdrFinite',
              'hdrRetainsAboveOne',
              'hdrRetainsNegative',
              'alphaDrift',
              'visibleDrift',
              'hiddenDrift'
            ].includes(k)
        )
        .map(([k, v]) => [k, typeof v === 'number' ? +v.toPrecision(5) : v])
    )
  )
)
