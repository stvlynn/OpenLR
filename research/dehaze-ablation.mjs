// Independent generated-data research; not a production image engine.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
const W = 64,
  H = 32,
  N = W * H,
  clamp = (v) => Math.max(0, Math.min(1, v)),
  lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
function local(values, r, minimum = false) {
  return values.map((_, i) => {
    let total = minimum ? Infinity : 0,
      n = 0
    const x = i % W,
      y = Math.floor(i / W)
    for (let yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r); yy++)
      for (let xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++) {
        const v = values[yy * W + xx]
        total = minimum ? Math.min(total, v) : total + v
        n++
      }
    return minimum ? total : total / n
  })
}
function guided(p, g, r = 3) {
  const mg = local(g, r),
    mp = local(p, r),
    gg = local(
      g.map((v) => v * v),
      r
    ),
    gp = local(
      g.map((v, i) => v * p[i]),
      r
    )
  const a = g.map((_, i) => (gp[i] - mg[i] * mp[i]) / (Math.max(0, gg[i] - mg[i] * mg[i]) + 1e-4)),
    b = p.map((_, i) => mp[i] - a[i] * mg[i]),
    ma = local(a, r),
    mb = local(b, r)
  return g.map((v, i) => ma[i] * v + mb[i])
}
function estimate(p, method) {
  const guide = p.map((v) => clamp(lum(v))),
    dark = local(
      p.map((v) => Math.min(...v.slice(0, 3).map(clamp))),
      2,
      true
    )
  const candidates = dark
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v || a.i - b.i)
    .slice(0, Math.max(1, Math.ceil(N * 0.001)))
  const chosen = candidates.reduce((a, b) => (lum(p[a.i]) >= lum(p[b.i]) ? a : b))
  const air = p[chosen.i].slice(0, 3).map((v) => Math.max(1e-4, clamp(v)))
  let ratio = p.map((v) => Math.min(...v.slice(0, 3).map((c, k) => Math.max(0, c) / air[k])))
  if (method !== 'pixel') ratio = local(ratio, 2, true)
  let t = ratio.map((v) => 1 - 0.95 * clamp(v))
  if (method === 'box') t = local(t, 3)
  if (method === 'guided') t = guided(t, guide)
  return { air, t: t.map((v) => Math.max(0.1, Math.min(1, v))) }
}
function apply(p, amount, estimate) {
  if (!amount) return p.map((v) => [...v])
  const { air, t } = estimate
  return p.map((v, i) => {
    if (!v[3]) return [...v]
    if (amount < 0) {
      const f = (-amount / 100) * 0.6
      return v.map((c, k) => (k === 3 ? c : c * (1 - f) + air[k] * f))
    }
    const tr = 1 - (amount / 100) * (1 - t[i])
    return v.map((c, k) => (k === 3 ? c : air[k] + (c - air[k]) / tr))
  })
}
const clear = Array.from({ length: N }, (_, i) => {
  const x = i % W,
    y = Math.floor(i / W)
  if (y < 4) return [0.85, 0.9, 1, 1]
  const c = [0.08 + (0.6 * x) / W, 0.07 + (0.55 * y) / H, 0.05 + (0.5 * ((x + y) % 11)) / 10]
  if (x % 3 === 0 && y % 3 === 0) c[(x + y) % 3] = 0
  return [...c, 1]
})
const air = [0.85, 0.9, 1],
  hazy = clear.map((v, i) => {
    const t = i % W < W / 2 ? 0.35 : 0.8
    return v.map((c, k) => (k === 3 ? c : c * t + air[k] * (1 - t)))
  })
function mse(a, b, edge = false) {
  let sum = 0,
    n = 0
  for (let i = 0; i < N; i++) {
    if (Math.floor(i / W) < 4 || (edge && Math.abs((i % W) - W / 2) > 3)) continue
    for (let c = 0; c < 3; c++) {
      sum += (a[i][c] - b[i][c]) ** 2
      n++
    }
  }
  return sum / n
}
const results = { node: process.version, dimensions: [W, H], baselineMse: mse(hazy, clear), methods: {} }
for (const method of ['pixel', 'patch', 'box', 'guided']) {
  const e = estimate(hazy, method),
    out = apply(hazy, 100, e),
    noHaze = apply(clear, 100, estimate(clear, method))
  results.methods[method] = {
    air: e.air,
    mse: mse(out, clear),
    edgeMse: mse(out, clear, true),
    clearMse: mse(noHaze, clear)
  }
}
const e = estimate(hazy, 'guided'),
  neutral = apply(hazy, 0, e),
  negative = apply(hazy, -100, e)
results.neutralMax = Math.max(...neutral.flatMap((v, i) => v.map((c, k) => Math.abs(c - hazy[i][k]))))
results.negativeContrastRatio =
  (negative[10 * W + 5][0] - negative[10 * W + 7][0]) / (hazy[10 * W + 5][0] - hazy[10 * W + 7][0])
const special = hazy.map((v) => [...v])
special[100] = [-1e20, 3e20, 0.1, 0.25]
special[101] = [9, -5, 2, 0]
const stress = apply(special, 100, e)
results.stress = {
  finite: stress.flat().every(Number.isFinite),
  alphaMax: Math.max(...stress.map((v, i) => Math.abs(v[3] - special[i][3]))),
  transparentUnchanged: stress[101].every((v, k) => v === special[101][k]),
  signedSample: stress[100]
}
const bright = Array.from({ length: N }, () => [0.7, 0.7, 0.7, 1])
const brightResult = apply(bright, 100, estimate(bright, 'guided'))
results.uniformBrightClear = { input: 0.7, output: brightResult[500][0], error: brightResult[500][0] - 0.7 }
const brightObjects = Array.from({ length: N }, (_, i) =>
  Math.floor(i / W) < 4 ? [0.95, 0.95, 0.95, 1] : i % W < W / 2 ? [0.7, 0.7, 0.7, 1] : [0.9, 0.9, 0.9, 1]
)
const distorted = apply(brightObjects, 100, estimate(brightObjects, 'guided'))
results.brightObjectsClear = {
  mse: mse(distorted, brightObjects),
  leftBefore: 0.7,
  leftAfter: distorted[16 * W + 16][0],
  rightBefore: 0.9,
  rightAfter: distorted[16 * W + 48][0]
}
assert.equal(results.neutralMax, 0)
assert.ok(results.methods.guided.mse < results.baselineMse)
assert.ok(results.stress.finite)
assert.equal(results.stress.alphaMax, 0)
assert.ok(results.stress.transparentUnchanged)
await mkdir('.workspace', { recursive: true })
await writeFile('.workspace/dehaze-ablation.json', JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
