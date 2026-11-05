import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeDehaze, dehazeFrame, createDehazePixel } from '../web/dehaze.js'

const frame = (width, height, pixels) => ({
  width,
  height,
  colorSpace: 'srgb-linear',
  data: Float32Array.from(pixels.flat())
})
const copy = (source) => ({ ...source, data: source.data.slice() })
const clamp = (v) => Math.max(0, Math.min(1, v))
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`)

// Independent direct-window oracle: full sorting and nested neighborhood loops,
// rather than the production heap, monotonic deques and running box sums.
function reference(source) {
  const { width, height, data } = source,
    n = width * height
  const alpha = Array.from({ length: n }, (_, i) => data[i * 4 + 3])
  const guide = Array.from(
    { length: n },
    (_, i) => 0.2126 * clamp(data[i * 4]) + 0.7152 * clamp(data[i * 4 + 1]) + 0.0722 * clamp(data[i * 4 + 2])
  )
  const neighborhood = (i, radius) => {
    const result = [],
      x = i % width,
      y = Math.floor(i / width)
    for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++)
      for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++)
        result.push(yy * width + xx)
    return result
  }
  const minimum = (values) =>
    values.map((_, i) =>
      Math.min(
        ...neighborhood(i, Math.max(2, Math.round(0.007 * Math.min(width, height))))
          .filter((j) => alpha[j] > 0)
          .map((j) => values[j])
      )
    )
  const mean = (values) =>
    values.map((_, i) => {
      let total = 0,
        count = 0
      for (const j of neighborhood(i, Math.max(3, Math.round(0.02 * Math.min(width, height))))) {
        total += values[j] * alpha[j]
        count += alpha[j]
      }
      return count ? total / count : 0
    })
  const dark = minimum(
    guide.map((_, i) => Math.min(clamp(data[i * 4]), clamp(data[i * 4 + 1]), clamp(data[i * 4 + 2])))
  )
  const candidates = dark
    .map((value, index) => ({ value, index }))
    .filter(({ index }) => alpha[index] > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index)
  const selected = candidates
    .slice(0, Math.max(1, Math.ceil(candidates.length * 0.001)))
    .sort((a, b) => guide[b.index] - guide[a.index] || a.index - b.index)[0].index
  const airlight = [0, 1, 2].map((c) => Math.max(1e-4, clamp(data[selected * 4 + c])))
  const coarse = minimum(
    guide.map((_, i) => Math.min(...[0, 1, 2].map((c) => Math.max(0, data[i * 4 + c]) / airlight[c])))
  ).map((value) => 1 - 0.95 * clamp(value))
  const meanGuide = mean(guide),
    meanT = mean(coarse)
  const meanSquare = mean(guide.map((v) => v * v)),
    meanProduct = mean(guide.map((v, i) => v * coarse[i]))
  const a = guide.map(
    (_, i) =>
      (meanProduct[i] - meanGuide[i] * meanT[i]) / (Math.max(0, meanSquare[i] - meanGuide[i] ** 2) + 1e-4)
  )
  const b = guide.map((_, i) => meanT[i] - a[i] * meanGuide[i])
  const averageA = mean(a),
    averageB = mean(b)
  return {
    airlight,
    transmission: guide.map((value, i) => Math.max(0.1, Math.min(1, averageA[i] * value + averageB[i])))
  }
}

function hazeFixture() {
  const width = 64,
    height = 32,
    air = [0.85, 0.9, 1]
  const clear = Array.from({ length: width * height }, (_, i) => {
    const x = i % width,
      y = Math.floor(i / width)
    if (y < 4) return [...air, 1]
    const rgb = [0.08 + (0.6 * x) / width, 0.07 + (0.55 * y) / height, 0.05 + (0.5 * ((x + y) % 11)) / 10]
    if (x % 3 === 0 && y % 3 === 0) rgb[(x + y) % 3] = 0
    return [...rgb, 1]
  })
  const hazy = clear.map((pixel, i) => {
    const t = i % width < width / 2 ? 0.35 : 0.8
    return pixel.map((value, c) => (c === 3 ? value : value * t + air[c] * (1 - t)))
  })
  return { clear: frame(width, height, clear), hazy: frame(width, height, hazy) }
}

test('dehaze neutral, tiny, black and transparent cases preserve exact boundaries', () => {
  const untouched = {
    get data() {
      throw Error('Neutral must not inspect samples')
    }
  }
  assert.equal(dehazeFrame(untouched, 0), untouched)
  for (const value of [NaN, Infinity, '5', -101, 101, null])
    assert.throws(() => dehazeFrame(untouched, value), /Dehaze/)
  const black = frame(1, 1, [[0, 0, 0, 0.5]])
  assert.equal(analyzeDehaze(black).black, true)
  assert.deepEqual(dehazeFrame(copy(black), 100).data, black.data)
  const negative = dehazeFrame(copy(black), -100)
  near(negative.data[0], 0.6)
  assert.equal(negative.data[3], 0.5)
  const transparent = frame(2, 1, [
    [-1e20, 2e20, 3, 0],
    [1, 2, 3, 0]
  ])
  assert.equal(analyzeDehaze(transparent).visible, 0)
  assert.deepEqual(dehazeFrame(copy(transparent), 100).data, transparent.data)
  assert.deepEqual(dehazeFrame(copy(transparent), -100).data, transparent.data)
  for (const [width, height] of [
    [1, 1],
    [1, 8],
    [8, 1],
    [2, 3]
  ]) {
    const input = frame(
      width,
      height,
      Array.from({ length: width * height }, () => [0.7, 0.8, 0.9, 1])
    )
    assert.deepEqual(dehazeFrame(copy(input), 100).data, input.data)
  }
})

test('source-resolution dehaze agrees with an independent window oracle and recovers a generated two-depth scene', () => {
  const { clear, hazy } = hazeFixture(),
    original = hazy.data.slice()
  const map = analyzeDehaze(hazy),
    expected = reference(hazy)
  assert.deepEqual(hazy.data, original, 'Analysis does not mutate its source')
  assert.deepEqual(map.airlight, expected.airlight)
  near(map.airlight[0], 0.85)
  near(map.airlight[1], 0.9)
  assert.equal(map.airlight[2], 1)
  let maximum = 0
  for (let i = 0; i < map.transmission.length; i++)
    maximum = Math.max(maximum, Math.abs(map.transmission[i] - expected.transmission[i]))
  assert.ok(maximum < 2e-5, `Float32 map deviation ${maximum}`)
  const frozen = map.transmission.slice(),
    corrected = dehazeFrame(copy(hazy), 100, map)
  let inputError = 0,
    outputError = 0,
    count = 0
  for (let i = 64 * 4 * 4; i < hazy.data.length; i++)
    if (i % 4 !== 3) {
      inputError += (hazy.data[i] - clear.data[i]) ** 2
      outputError += (corrected.data[i] - clear.data[i]) ** 2
      count++
    }
  assert.ok(outputError < inputError * 0.06)
  near(outputError / count, 0.00468984, 2e-7)
  assert.deepEqual(map.transmission, frozen)
  assert.deepEqual(hazy.data, original)
  const lower = dehazeFrame(copy(hazy), 25, map)
  for (let i = 0; i < hazy.data.length; i++) {
    if (i % 4 === 3) assert.equal(corrected.data[i], hazy.data[i])
    else
      assert.ok(Math.abs(lower.data[i] - hazy.data[i]) <= Math.abs(corrected.data[i] - hazy.data[i]) + 1e-7)
  }
  const negativeMap = analyzeDehaze(hazy, { transmission: false })
  assert.equal(negativeMap.transmission, null)
  const veil = dehazeFrame(copy(hazy), -100, negativeMap)
  near((veil.data[2600] - veil.data[2608]) / (hazy.data[2600] - hazy.data[2608]), 0.4, 1e-5)
  assert.deepEqual(dehazeFrame(copy(hazy), 100, negativeMap).data, corrected.data)
})

test('alpha-weighted dehaze ignores hidden colors and preserves signed HDR samples during reconstruction', () => {
  const width = 13,
    height = 9
  const pixels = Array.from({ length: width * height }, (_, i) => [
    0.2 + (i % 7) / 10,
    0.4,
    0.7,
    i % 5 === 0 ? 0 : i % 3 === 0 ? 0.2 : 1
  ])
  const source = frame(width, height, pixels),
    altered = copy(source)
  for (let i = 0; i < pixels.length; i++)
    if (!source.data[i * 4 + 3]) {
      source.data.set([9e20, -8e20, 1e20], i * 4)
      altered.data.set([-7e20, 6e20, -5e20], i * 4)
    }
  const a = analyzeDehaze(source),
    b = analyzeDehaze(altered),
    oracle = reference(source)
  assert.deepEqual(a.airlight, b.airlight)
  assert.deepEqual(a.airlight, oracle.airlight)
  const outputA = dehazeFrame(copy(source), 100, a),
    outputB = dehazeFrame(copy(altered), 100, b)
  for (let i = 0; i < pixels.length; i++) {
    const offset = i * 4
    assert.equal(outputA.data[offset + 3], source.data[offset + 3])
    if (source.data[offset + 3]) {
      near(a.transmission[i], oracle.transmission[i], 2e-5)
      assert.equal(a.transmission[i], b.transmission[i])
      assert.deepEqual(outputA.data.slice(offset, offset + 3), outputB.data.slice(offset, offset + 3))
    } else assert.deepEqual(outputA.data.slice(offset, offset + 3), source.data.slice(offset, offset + 3))
  }
  const stress = copy(source)
  stress.data.set([-1e20, 3e20, 0.1, 0.25], 4)
  dehazeFrame(stress, 100, a)
  assert.ok(stress.data.every(Number.isFinite))
  assert.ok(stress.data[4] < -1e20 && stress.data[5] > 3e20)
  assert.equal(stress.data[7], 0.25)
  const subnormal = frame(2, 1, [
    [0.2, 0.4, 0.6, 2 ** -149],
    [0.3, 0.5, 0.7, 2 ** -149]
  ])
  assert.ok(dehazeFrame(copy(subnormal), 100).data.every(Number.isFinite))
})

test('fused dehaze pixel reads match materialized Float32 results and report overflow visibly', () => {
  const { hazy } = hazeFixture(),
    map = analyzeDehaze(hazy)
  for (const amount of [-100, -25, 0, 25, 100]) {
    const expected = dehazeFrame(copy(hazy), amount, map).data
    const apply = createDehazePixel(amount, map),
      output = new Float64Array(8)
    for (const index of [0, 23, 640, 1277, 2047]) {
      apply(hazy.data, index * 4, output, 4)
      assert.deepEqual(
        Array.from(output.subarray(4)),
        Array.from(expected.subarray(index * 4, index * 4 + 4))
      )
    }
  }
  const mapOne = {
    width: 1,
    height: 1,
    visible: 1,
    black: false,
    airlight: [1, 1, 1],
    transmission: new Float32Array([1])
  }
  const tiny = new Float32Array([1e-30, -1e-30, 0, 0.5]),
    result = new Float64Array(4)
  createDehazePixel(100, mapOne)(tiny, 0, result)
  assert.deepEqual(
    Array.from(result),
    Array.from(tiny),
    'Unit transmission must not lose tiny samples to cancellation'
  )
  const maximum = new Float32Array([3e38, 3e38, 3e38, 1])
  const overflow = { ...mapOne, transmission: new Float32Array([0.1]) }
  assert.throws(() => createDehazePixel(100, overflow)(maximum, 0, result), /non-finite pixel/)
  assert.throws(() => dehazeFrame(frame(1, 1, [Array.from(maximum)]), 100, overflow), /non-finite pixel/)
  assert.throws(() => dehazeFrame(copy(hazy), 100, mapOne), /does not match/)
})
