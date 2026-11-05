import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
function compile(points, cubic) {
  const n = points.length,
    h = [],
    d = [],
    m = []
  for (let i = 0; i < n - 1; i++) {
    h[i] = points[i + 1].x - points[i].x
    d[i] = (points[i + 1].y - points[i].y) / h[i]
  }
  const end = (a, b, u, v) => {
    let z = ((2 * a + b) * u - a * v) / (a + b)
    return Math.sign(z) !== Math.sign(u)
      ? 0
      : Math.sign(u) !== Math.sign(v) && Math.abs(z) > 3 * Math.abs(u)
        ? 3 * u
        : z
  }
  if (n === 2) m[0] = m[1] = d[0]
  else {
    m[0] = end(h[0], h[1], d[0], d[1])
    m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3])
    for (let i = 1; i < n - 1; i++) {
      const a = d[i - 1],
        b = d[i]
      m[i] =
        a * b <= 0 ? 0 : (3 * (h[i - 1] + h[i])) / ((2 * h[i] + h[i - 1]) / a + (h[i] + 2 * h[i - 1]) / b)
    }
  }
  return (x) => {
    if (x <= 0) return x + points[0].y
    if (x >= 1) return x + points[n - 1].y - 1
    let i = 0
    while (i < n - 2 && x > points[i + 1].x) i++
    const t = (x - points[i].x) / h[i],
      a = points[i].y,
      b = points[i + 1].y
    return cubic
      ? (2 * t ** 3 - 3 * t * t + 1) * a +
          (t ** 3 - 2 * t * t + t) * h[i] * m[i] +
          (-2 * t ** 3 + 3 * t * t) * b +
          (t ** 3 - t * t) * h[i] * m[i + 1]
      : a + t * (b - a)
  }
}
const points = (ys) => ys.map((y, i) => ({ x: i / (ys.length - 1), y }))
const fixtures = [
  points([0, 0.02, 0.03, 0.85, 1]),
  points([0, 0.8, 0.1, 0.9, 1]),
  points([0.15, 0.15, 0.4, 0.7, 0.8]),
  [
    { x: 0, y: 0 },
    { x: 0.01, y: 0.4 },
    { x: 0.02, y: 0.41 },
    { x: 0.9, y: 0.8 },
    { x: 1, y: 1 }
  ]
]
const output = {
  node: process.version,
  platform: process.platform,
  fixtures: fixtures.length,
  samplesPerSegment: 1001,
  methods: {}
}
for (const cubic of [false, true]) {
  let overshoot = 0,
    knotError = 0,
    identityError = 0,
    jump = 0,
    farDelta = 0
  for (const p of fixtures) {
    const f = compile(p, cubic)
    for (const q of p) knotError = Math.max(knotError, Math.abs(f(q.x) - q.y))
    for (let i = 0; i < p.length - 1; i++)
      for (let j = 0; j <= 1000; j++) {
        const y = f(p[i].x + ((p[i + 1].x - p[i].x) * j) / 1000)
        overshoot = Math.max(overshoot, Math.min(p[i].y, p[i + 1].y) - y, y - Math.max(p[i].y, p[i + 1].y))
      }
    for (let i = 1; i < p.length - 1; i++) {
      const x = p[i].x,
        e = 1e-7
      jump = Math.max(jump, Math.abs((f(x + e) - f(x)) / e - (f(x) - f(x - e)) / e))
    }
  }
  const identity = compile(points([0, 0.25, 0.5, 0.75, 1]), cubic)
  for (let i = -10000; i <= 30000; i++)
    identityError = Math.max(identityError, Math.abs(identity(i / 10000) - i / 10000))
  const p = points([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]),
    q = structuredClone(p)
  q[5].y = 0.56
  const a = compile(p, cubic),
    b = compile(q, cubic)
  for (let i = 0; i <= 1000; i++) {
    const x = i / 1000
    if (x <= 0.3 || x >= 0.7) farDelta = Math.max(farDelta, Math.abs(a(x) - b(x)))
  }
  const shifted = compile(points([0.15, 0.4, 0.8]), cubic),
    e = 1e-9
  const tails = {
    negative: shifted(-0.5),
    hdr: shifted(2),
    blackBoundaryDelta: Math.abs(shifted(e) - shifted(-e)),
    whiteBoundaryDelta: Math.abs(shifted(1 + e) - shifted(1 - e))
  }
  assert.ok(overshoot < 1e-12 && knotError < 1e-12 && identityError < 1e-12 && farDelta < 1e-12)
  output.methods[cubic ? 'pchip' : 'linear'] = {
    overshoot,
    knotError,
    identityError,
    maxInteriorSlopeJump: jump,
    farDelta,
    tails
  }
}
await mkdir('.workspace', { recursive: true })
await writeFile('.workspace/point-tone-curves-ablation.json', JSON.stringify(output, null, 2))
console.log(JSON.stringify(output, null, 2))
