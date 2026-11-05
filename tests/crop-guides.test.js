import test from 'node:test'
import assert from 'node:assert/strict'
import { CROP_GUIDES, cropGuideGeometry } from '../web/crop-guides.js'
import { validateArgs } from '../web/agent-protocol.js'

test('composition geometry stays inside landscape, portrait and tiny crop frames', () => {
  for (const type of Object.keys(CROP_GUIDES))
    for (const [width, height] of [
      [480, 240],
      [120, 360],
      [1, 1]
    ])
      for (let orientation = 0; orientation < 4; orientation++) {
        const { paths } = cropGuideGeometry(type, width, height, orientation)
        for (const points of paths)
          for (const [x, y] of points) {
            assert.ok(Number.isFinite(x) && x >= -1e-8 && x <= width + 1e-8, `${type} x=${x}`)
            assert.ok(Number.isFinite(y) && y >= -1e-8 && y <= height + 1e-8, `${type} y=${y}`)
          }
      }
})

test('thirds, diagonal, triangle, golden ratio and reference frames use physical geometry', () => {
  assert.deepEqual(cropGuideGeometry('thirds', 300, 180).paths[0], [
    [100, 0],
    [100, 180]
  ])
  assert.deepEqual(cropGuideGeometry('diagonal', 300, 180).paths[0], [
    [0, 0],
    [180, 180]
  ])
  const triangle = cropGuideGeometry('triangle', 300, 180).paths
  const [start, end] = triangle[1]
  assert.ok(Math.abs((end[0] - start[0]) * 300 + (end[1] - start[1]) * 180) < 1e-7)
  const golden = cropGuideGeometry('golden-ratio', 300, 180).paths
  assert.ok(Math.abs(golden[0][0][0] / 300 - 0.38196601125) < 1e-10)
  const frames = cropGuideGeometry('aspect-ratios', 300, 180)
  assert.equal(frames.paths.length, 4)
  for (const [i, ratio] of [1, 0.8, 1.5, 16 / 9].entries()) {
    const points = frames.paths[i]
    assert.ok(Math.abs((points[1][0] - points[0][0]) / (points[2][1] - points[1][1]) - ratio) < 1e-10)
  }
  const original = cropGuideGeometry('golden-spiral', 300, 180).paths[0]
  // Successive quarter-turn chords must rotate 90 degrees and grow by phi,
  // including on a non-golden crop aspect. An anisotropically stretched curve fails this.
  for (const [width, height] of [
    [300, 180],
    [120, 360]
  ]) {
    const points = cropGuideGeometry('golden-spiral', width, height).paths[0]
    const a = [points[40][0] - points[0][0], points[40][1] - points[0][1]]
    const b = [points[80][0] - points[40][0], points[80][1] - points[40][1]]
    assert.ok(Math.abs(Math.hypot(...b) / Math.hypot(...a) - (1 + Math.sqrt(5)) / 2) < 1e-10)
    assert.ok(Math.abs(a[0] * b[0] + a[1] * b[1]) < 1e-9)
  }
  const mirrored = cropGuideGeometry('golden-spiral', 300, 180, 3).paths[0]
  original.forEach(([x, y], i) => assert.deepEqual(mirrored[i], [300 - x, 180 - y]))
})

test('shared crop-guide schema rejects invalid view state before dispatch', () => {
  validateArgs('crop-guide', { type: 'thirds', orientation: 0 })
  for (const args of [
    { type: 'bad' },
    { type: 'triangle', orientation: 0.5 },
    { type: 'grid', orientation: 4 }
  ])
    assert.throws(() => validateArgs('crop-guide', args))
})
