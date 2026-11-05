// Narrow ICC input interpretation; capability and independent measurements:
// research/float-input-color.md. LUT/CMYK/general CMS work is intentionally separate.
import { evaluateParametricCurve, validateRgbProfile } from './color-profile.js'
import { matrixToLinearSrgb } from './color-spaces.js'

const FLOAT32_MAX = 3.4028234663852886e38
const MATRIX_TAGS = ['rXYZ', 'gXYZ', 'bXYZ']
const CURVE_TAGS = ['rTRC', 'gTRC', 'bTRC']

function signature(view, at) {
  return String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)))
}

function curve(view, at, size) {
  if (signature(view, at) === 'para') {
    const type = view.getUint16(at + 8),
      parameters = Array.from({ length: (size - 12) / 4 }, (_, i) => view.getInt32(at + 12 + i * 4) / 65536)
    return (x) => evaluateParametricCurve(type, parameters, x)
  }
  const count = view.getUint32(at + 8)
  if (count === 0) return (x) => x
  if (count === 1) {
    const gamma = view.getUint16(at + 12) / 256
    return (x) => x ** gamma
  }
  const table = Array.from({ length: count }, (_, i) => view.getUint16(at + 12 + i * 2) / 65535)
  return (x) => {
    const position = x * (count - 1),
      index = Math.min(count - 2, Math.floor(position)),
      fraction = position - index
    return table[index] * (1 - fraction) + table[index + 1] * fraction
  }
}

/** Compile the supported RGB ICC matrix/TRC subset into an input transform.
 * Malformed profiles throw; valid containers outside this interpreter's subset
 * return a stable technical reason for the decode adapter's visible fallback.
 * convert accepts three finite normalized encoded components in [0,1], writes
 * only RGB to caller-owned float-capable storage, and preserves unbounded linear
 * output. Alpha and source sample normalization belong to the codec adapter.
 */
export function createProfileToLinearSrgb(input) {
  const bytes = validateRgbProfile(input),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    tags = new Map()
  for (let i = 0; i < view.getUint32(128); i++) {
    const entry = 132 + i * 12
    tags.set(signature(view, entry), { at: view.getUint32(entry + 4), size: view.getUint32(entry + 8) })
  }
  if (signature(view, 20) !== 'XYZ ') return { reason: 'profile-pcs' }
  if (!['scnr', 'mntr'].includes(signature(view, 12))) return { reason: 'profile-class' }
  if ([...tags.keys()].some((id) => /^(A2B[012]|D2B[0123])$/.test(id))) return { reason: 'profile-lut' }
  // These can change a profile's interpretation beyond this matrix/TRC subset.
  if (['cicp', 'arts'].some((id) => tags.has(id))) return { reason: 'profile-interpretation' }
  if (![...MATRIX_TAGS, ...CURVE_TAGS].every((id) => tags.has(id)))
    return { reason: 'profile-matrix-trc-missing' }
  if (view.getUint8(8) === 2 && CURVE_TAGS.some((id) => signature(view, tags.get(id).at) === 'para'))
    return { reason: 'profile-v2-parametric' }
  const columns = MATRIX_TAGS.map((id) => {
      const { at } = tags.get(id)
      return [8, 12, 16].map((offset) => view.getInt32(at + offset) / 65536)
    }),
    matrix = [0, 1, 2].flatMap((row) => columns.map((column) => column[row])),
    [a, b, c, d, e, f, g, h, i] = matrix,
    determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (determinant === 0) throw Error('Invalid RGB ICC profile: singular colorant matrix')
  const transform = matrixToLinearSrgb(matrix),
    curves = CURVE_TAGS.map((id) => {
      const { at, size } = tags.get(id)
      return curve(view, at, size)
    })
  return {
    kind: 'matrix-trc',
    convert(r, g, b, out, offset = 0) {
      if (
        !Number.isFinite(r) ||
        r < 0 ||
        r > 1 ||
        !Number.isFinite(g) ||
        g < 0 ||
        g > 1 ||
        !Number.isFinite(b) ||
        b < 0 ||
        b > 1
      )
        throw new RangeError('ICC input components must be finite normalized values in [0,1]')
      if (
        !out ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset + 3 > out.length ||
        !(Array.isArray(out) || out instanceof Float32Array || out instanceof Float64Array)
      )
        throw new TypeError('ICC conversion requires float-capable RGB output storage')
      const x = curves[0](r),
        y = curves[1](g),
        z = curves[2](b),
        red = transform[0] * x + transform[1] * y + transform[2] * z,
        green = transform[3] * x + transform[4] * y + transform[5] * z,
        blue = transform[6] * x + transform[7] * y + transform[8] * z
      if (![red, green, blue].every((value) => Number.isFinite(value) && Math.abs(value) <= FLOAT32_MAX))
        throw Error('Invalid RGB ICC profile: conversion exceeds finite Float32 range')
      out[offset] = red
      out[offset + 1] = green
      out[offset + 2] = blue
      return out
    }
  }
}
