import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeDehaze, dehazeFrame } from '../web/dehaze.js'
import { transformFrame } from '../web/frame-geometry.js'
import { renderFrame } from '../web/render.js'

test('fused Dehaze geometry is bit-exact to materialized Float32 reconstruction for crop, resize, turn, flip, alpha and extended RGB', () => {
  const width = 19,
    height = 13
  const data = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        at = i * 4
      data.set(
        [
          x % 5 === 0 ? -0.3 : 0.1 + x / 10,
          y % 4 === 0 ? 2.7 : 0.05 + y / 16,
          (x + y) % 7 === 0 ? -1.2 : 0.1 + ((x * 3 + y) % 17) / 12,
          [0, 0.2, 0.7, 1][i % 4]
        ],
        at
      )
    }
  const frame = { width, height, data, colorSpace: 'srgb-linear' }
  const original = data.slice()
  const analysis = analyzeDehaze(frame)
  for (const amount of [-100, -35, 30, 100]) {
    const materialized = dehazeFrame({ ...frame, data: frame.data.slice() }, amount, analysis)
    for (const crop of [undefined, { x: 0.1, y: 0.15, w: 0.73, h: 0.7 }])
      for (const turn of [0, 1, 2, 3])
        for (const flip of [false, true])
          for (const maxSize of [Infinity, 7, 40]) {
            const edit = { Dehaze: amount, ...(crop ? { crop } : {}), turn, flip }
            const expected = transformFrame(materialized, edit, maxSize)
            const actual = renderFrame(frame, edit, maxSize)
            assert.deepEqual([actual.width, actual.height], [expected.width, expected.height])
            assert.deepEqual(
              actual.data,
              expected.data,
              JSON.stringify({ amount, crop, turn, flip, maxSize })
            )
          }
  }
  assert.deepEqual(frame.data, original, 'Neither reconstruction nor fused sampling changes the source')
})
