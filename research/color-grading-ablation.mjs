// Independent numerical experiment, not a production renderer.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
const yOf = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
function weights(y, balance = 0, blending = 50, hard = false) {
  const z = Math.max(0, y),
    pivot = 0.18 * 2 ** (-balance / 50),
    t = z / (z + pivot)
  if (hard) return t < 1 / 3 ? [1, 0, 0] : t > 2 / 3 ? [0, 0, 1] : [0, 1, 0]
  const q = 4 - (3 * blending) / 100,
    a = [(1 - t) ** 2, 2 * t * (1 - t), t * t].map((v) => v ** q),
    sum = a.reduce((s, v) => s + v, 0)
  return a.map((v) => v / sum)
}
function direction(hue, center) {
  const h = (((hue % 360) + 360) % 360) / 60,
    x = 1 - Math.abs((h % 2) - 1),
    rgb = [
      [1, x, 0],
      [x, 1, 0],
      [0, 1, x],
      [0, x, 1],
      [x, 0, 1],
      [1, 0, x]
    ][Math.floor(h)]
  const linear = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  if (!center) return linear
  const y = yOf(linear),
    v = linear.map((c) => c - y),
    m = Math.max(...v.map(Math.abs))
  return v.map((c) => c / m)
}
function grade(p, bands, { center = true, hard = false, balance = 0, blending = 50 } = {}) {
  if (bands.every((b) => !b.saturation && !b.luminance)) return [...p]
  const w = [...weights(yOf(p), balance, blending, hard), 1],
    scale = Math.max(...p.slice(0, 3).map(Math.abs)),
    delta = [0, 0, 0]
  let stops = 0
  bands.forEach((b, i) => {
    const d = direction(b.hue, center)
    for (let c = 0; c < 3; c++) delta[c] += ((w[i] * b.saturation) / 100) * 0.25 * d[c]
    stops += (w[i] * (b.luminance || 0)) / 50
  })
  return [...p.slice(0, 3).map((v, c) => (v + scale * delta[c]) * 2 ** stops), p[3]]
}
const bands = [
    { hue: 220, saturation: 70 },
    { hue: 30, saturation: 40 },
    { hue: 50, saturation: 55 },
    { hue: 300, saturation: 10 }
  ],
  neutral = bands.map((b) => ({ ...b, saturation: 0 }))
const samples = Array.from({ length: 1001 }, (_, i) => {
  const v = (i / 1000) * 4
  return [v, v, v, (i % 11) / 10]
}).concat([
  [0, 0, 0, 0],
  [-0.5, -0.2, 0.1, 0.25],
  [4, 0.1, 0.2, 1],
  [0.02, 0.8, 0.06, 0.8],
  [-2, -1, -0.2, 0.4]
])
const results = { node: process.version, platform: process.platform, samples: samples.length, schemes: {} }
for (const [name, options] of [
  ['raw-hue-addition', { center: false }],
  ['zero-luminance-tint', {}]
]) {
  let yError = 0,
    neutralError = 0,
    alphaError = 0,
    nonfinite = 0,
    minimum = Infinity,
    maximum = -Infinity
  for (const p of samples) {
    const out = grade(p, bands, options),
      idle = grade(p, neutral, options)
    yError = Math.max(yError, Math.abs(yOf(out) - yOf(p)))
    alphaError = Math.max(alphaError, Math.abs(out[3] - p[3]))
    for (let c = 0; c < 4; c++) {
      neutralError = Math.max(neutralError, Math.abs(idle[c] - p[c]))
      if (!Number.isFinite(out[c])) nonfinite++
    }
    minimum = Math.min(minimum, ...out.slice(0, 3))
    maximum = Math.max(maximum, ...out.slice(0, 3))
  }
  results.schemes[name] = {
    maximumLuminanceError: yError,
    neutralError,
    alphaError,
    nonfinite,
    minimum,
    maximum
  }
}
results.weights = {}
for (const hard of [true, false]) {
  let partitionError = 0,
    negative = 0,
    jump = 0
  for (const balance of [-100, 0, 100])
    for (const blending of [0, 50, 100]) {
      let prev
      for (let i = 0; i <= 10000; i++) {
        const y = (i / 10000) * 4,
          w = weights(y, balance, blending, hard)
        partitionError = Math.max(partitionError, Math.abs(w.reduce((s, v) => s + v, 0) - 1))
        negative += w.filter((v) => v < 0).length
        if (prev) jump = Math.max(jump, ...w.map((v, k) => Math.abs(v - prev[k])))
        prev = w
      }
    }
  results.weights[hard ? 'hard-bands' : 'normalized-smooth'] = { partitionError, negative, maxRampStep: jump }
}
const gray = [0.18, 0.18, 0.18, 1],
  shift = [-100, 0, 100].map((balance) => ({ balance, weights: weights(0.18, balance, 50) }))
results.balance = shift
results.luminanceGain =
  grade(gray, [...neutral.slice(0, 3), { hue: 0, saturation: 0, luminance: 50 }])[0] / 0.18
assert.equal(results.schemes['zero-luminance-tint'].neutralError, 0)
assert.ok(results.schemes['zero-luminance-tint'].maximumLuminanceError < 1e-12)
assert.equal(results.schemes['zero-luminance-tint'].nonfinite, 0)
assert.equal(results.schemes['zero-luminance-tint'].alphaError, 0)
assert.ok(results.weights['normalized-smooth'].partitionError < 1e-12)
assert.equal(results.luminanceGain, 2)
const stressInputs = [
  [-1e30, 1e30, 2e29, 0.25],
  [1e30, 1e30, 1e30, 1],
  [-1e30, -1e30, -1e30, 0],
  [1e-30, -1e-30, 0, 0.5],
  [0, 0, 0, 1]
]
let stressNonfinite = 0,
  stressAlphaError = 0,
  stressMaximum = 0
for (const luminance of [-100, 100])
  for (const balance of [-100, 100])
    for (const blending of [0, 100])
      for (const p of stressInputs) {
        const out = grade(
          p,
          bands.map((b) => ({ ...b, saturation: 100, luminance })),
          { balance, blending }
        )
        stressNonfinite += out.filter((v) => !Number.isFinite(v)).length
        stressAlphaError = Math.max(stressAlphaError, Math.abs(out[3] - p[3]))
        stressMaximum = Math.max(stressMaximum, ...out.slice(0, 3).map(Math.abs))
      }
results.stress = {
  cases: 40,
  nonfinite: stressNonfinite,
  alphaError: stressAlphaError,
  maximumAbsoluteComponent: stressMaximum,
  minimumGain: 1 / 16,
  maximumGain: 16
}
assert.equal(stressNonfinite, 0)
assert.equal(stressAlphaError, 0)
await mkdir('.workspace', { recursive: true })
await writeFile('.workspace/color-grading-ablation.json', JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
