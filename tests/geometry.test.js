import test from 'node:test'
import assert from 'node:assert/strict'
import { geometry } from '../web/geometry.js'

const source = { width: 591, height: 253 }

test('an unconstrained odd-sized image keeps its exact source rectangle', () => {
  assert.deepEqual(geometry(source), { x: 0, y: 0, w: 591, h: 253, ...source, turn: 0, flip: false })
})

test('crop bounds are preserved or fitted on both axes before rotation and reflection', () => {
  const crop = { x: 0.25, y: 0.125, w: 0.5, h: 0.75 }
  assert.deepEqual(geometry(source, { crop, turn: 3, flip: true }, 197), {
    x: 147.75,
    y: 31.625,
    w: 295.5,
    h: 189.75,
    width: 197,
    height: 127,
    turn: 3,
    flip: true
  })
  const rectangle = ({ x, y, w, h }) => [x, y, w, h]
  assert.deepEqual(rectangle(geometry(source, { crop, aspect: '1' })), [200.625, 31.625, 189.75, 189.75])
  assert.deepEqual(rectangle(geometry(source, { crop, aspect: '1.5' })), [153.1875, 31.625, 284.625, 189.75])
  assert.deepEqual(rectangle(geometry(source, { crop, aspect: '2' })), [147.75, 52.625, 295.5, 147.75])
  assert.deepEqual(rectangle(geometry(source, { aspect: source.width / source.height })), [0, 0, 591, 253])
})
