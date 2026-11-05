import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFrameOutputSharpening } from '../web/output-sharpening.js'

function frame(width, height, sample) {
  const data = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(sample(x, y), (y * width + x) * 4)
  return { width, height, data, colorSpace: 'srgb-linear' }
}
const clone = (source) => ({ ...source, data: source.data.slice() })

test('output sharpening None is an exact identity and invalid levels or frames fail visibly', () => {
  const source = frame(4, 3, (x, y) => [x - 1, y * 0.1, 1.5, x / 3]),
    before = source.data.slice()
  assert.equal(applyFrameOutputSharpening(source), source)
  assert.deepEqual(source.data, before)
  assert.throws(() => applyFrameOutputSharpening(source, 'print'), /supported output sharpening/)
  assert.throws(() => applyFrameOutputSharpening({ ...source, width: 0 }, 'low'), /dimensions/)
  assert.throws(() => applyFrameOutputSharpening({ ...source, colorSpace: 'srgb' }, 'low'), /linear sRGB/)
})

test('uniform colors, transparent hidden RGB and alpha stay unchanged without clipping signed HDR', () => {
  for (const [width, height] of [
    [1, 1],
    [1, 9],
    [9, 1],
    [9, 7]
  ])
    for (const level of ['low', 'standard', 'high']) {
      const source = frame(width, height, (x, y) =>
          x < 3 ? [100, -50, 10, 0] : [1.5, -0.125, 0, (y + 1) / height]
        ),
        before = source.data.slice()
      applyFrameOutputSharpening(source, level)
      assert.deepEqual(source.data, before)
    }
  const changing = frame(12, 4, (x, y) => [1.5 + x * 0.01, -0.2 + y * 0.005, 0.3, 1])
  applyFrameOutputSharpening(changing, 'high')
  assert.ok(changing.data.every(Number.isFinite))
  assert.ok(changing.data.some((value) => value > 1))
  assert.ok(changing.data.some((value) => value < 0))
})

test('separable alpha-aware sharpening agrees with an independent direct two-dimensional convolution', () => {
  const source = frame(7, 5, (x, y) => [
      x * 0.11 - y * 0.08,
      y * 0.17,
      x > 3 ? 1.5 : 0.2,
      (x + y) % 4 ? (y + 1) / 5 : 0
    ]),
    expected = source.data.slice()
  const luma = (i) => source.data[i] * 0.2126 + source.data[i + 1] * 0.7152 + source.data[i + 2] * 0.0722
  for (let y = 0; y < source.height; y++)
    for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4
      if (!source.data[i + 3]) continue
      let sum = 0,
        coverage = 0
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const px = Math.max(0, Math.min(source.width - 1, x + dx)),
            py = Math.max(0, Math.min(source.height - 1, y + dy)),
            n = (py * source.width + px) * 4
          const weight = Math.exp(-(dx * dx + dy * dy) / (2 * 0.65 * 0.65)) * source.data[n + 3]
          sum += luma(n) * weight
          coverage += weight
        }
      const delta = Math.max(-0.009, Math.min(0.009, 0.6 * (luma(i) - sum / coverage)))
      for (let c = 0; c < 3; c++) expected[i + c] += delta
    }
  const result = applyFrameOutputSharpening(clone(source), 'standard')
  for (let i = 0; i < expected.length; i++)
    assert.ok(Math.abs(result.data[i] - expected[i]) < 2e-7, 'sample ' + i)
  for (let i = 3; i < expected.length; i += 4) assert.equal(result.data[i], source.data[i])
})

test('output strengths increase final-size edge contrast while bounding halos and preserving channel differences', () => {
  const source = frame(17, 9, (x) => {
    const value = x < 8 ? 0.2 : 0.7
    return [value, value + 0.08, value - 0.04, 1]
  })
  const contrast = (data) => data[(4 * 17 + 8) * 4] - data[(4 * 17 + 7) * 4]
  let previous = contrast(source.data)
  for (const [level, limit] of [
    ['low', 0.0045],
    ['standard', 0.009],
    ['high', 0.015]
  ]) {
    const result = applyFrameOutputSharpening(clone(source), level)
    assert.ok(contrast(result.data) > previous)
    previous = contrast(result.data)
    for (let i = 0; i < result.data.length; i += 4) {
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(result.data[i + c] - source.data[i + c]) <= limit + 6e-8)
      assert.ok(Math.abs(result.data[i] - result.data[i + 1] - (source.data[i] - source.data[i + 1])) < 1e-7)
      assert.equal(result.data[i + 3], source.data[i + 3])
    }
  }
})
