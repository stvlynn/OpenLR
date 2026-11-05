import { decodeSrgb, encodeSrgb } from './color-spaces.js'

export const CURVE_CHANNELS = ['rgb', 'red', 'green', 'blue']
export const CURVE_MESSAGES = {
  title: 'Point curve',
  channel: 'Channel',
  channels: { rgb: 'RGB', red: 'Red', green: 'Green', blue: 'Blue' },
  point: 'Point',
  input: 'Input',
  output: 'Output',
  add: 'Add point',
  remove: 'Delete point',
  reset: 'Reset channel',
  graph: 'Tone curve',
  invalidPoints: 'Curve points must have increasing input values from 0 to 1 and output values from 0 to 1',
  invalidChannel: 'Unknown curve channel',
  invalidCurves: 'Invalid tone curves',
  changedPhoto: 'The active photo changed. Edit the curve again.',
  changedEdit: 'The photo edits changed. Edit the curve again.'
}

const identity = () => [
  { x: 0, y: 0 },
  { x: 1, y: 1 }
]
const isIdentity = (points) => points.every(({ x, y }) => x === y)
function channelName(channel) {
  if (!CURVE_CHANNELS.includes(channel)) throw Error(CURVE_MESSAGES.invalidChannel)
  return channel
}

export function validateCurvePoints(points) {
  if (
    !Array.isArray(points) ||
    points.length < 2 ||
    Array.from(points).some(
      (point, index) =>
        !point ||
        typeof point !== 'object' ||
        Array.isArray(point) ||
        Object.keys(point).some((key) => key !== 'x' && key !== 'y') ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.x > 1 ||
        point.y < 0 ||
        point.y > 1 ||
        (index > 0 && point.x <= points[index - 1].x)
    ) ||
    points[0].x !== 0 ||
    points.at(-1).x !== 1
  )
    throw Error(CURVE_MESSAGES.invalidPoints)
  return points.map(({ x, y }) => ({ x, y }))
}

export function validateToneCurves(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(CURVE_MESSAGES.invalidCurves)
  const result = {}
  for (const [channel, points] of Object.entries(value))
    result[channelName(channel)] = validateCurvePoints(points)
  return result
}

export function validateToneCurveRecipe(edit = {}) {
  if (edit.toneCurves !== undefined) validateToneCurves(edit.toneCurves)
  return edit
}

export function curvePoints(edit, channel) {
  channelName(channel)
  return edit?.toneCurves?.[channel] === undefined
    ? identity()
    : validateCurvePoints(edit.toneCurves[channel])
}

export function setToneCurve(edit, channel, points) {
  channelName(channel)
  const next = validateCurvePoints(points)
  const curves = edit.toneCurves === undefined ? {} : validateToneCurves(edit.toneCurves)
  if (next.length === 2 && isIdentity(next)) delete curves[channel]
  else curves[channel] = next
  const result = { ...edit }
  if (Object.keys(curves).length) result.toneCurves = curves
  else delete result.toneCurves
  return result
}

export function hasToneCurveEffect(value) {
  if (value === undefined) return false
  return Object.values(validateToneCurves(value)).some((points) => !isIdentity(points))
}

// Shape-preserving Hermite interpolation in encoded coordinates. Store m*h,
// not the unscaled derivative: arbitrarily close legal x values can overflow
// a slope while their segment contribution remains finite and bounded.
export function compileCurve(input) {
  const points = validateCurvePoints(input)
  if (isIdentity(points)) return (x) => x
  const count = points.length - 1
  const widths = Array.from({ length: count }, (_, i) => points[i + 1].x - points[i].x)
  const changes = Array.from({ length: count }, (_, i) => points[i + 1].y - points[i].y)
  const left = new Float64Array(count),
    right = new Float64Array(count)
  if (count === 1) left[0] = right[0] = changes[0]
  else {
    const endpoint = (h0, h1, d0, d1) => {
      const scale = Math.max(h0, h1),
        a = h0 / scale,
        b = h1 / scale
      const tangent = ((2 * a + b) * d0 - a * a * (d1 / b)) / (a + b)
      if (Math.sign(tangent) !== Math.sign(d0)) return 0
      if (Math.sign(d0) !== Math.sign(d1) && Math.abs(tangent) > 3 * Math.abs(d0)) return 3 * d0
      return tangent
    }
    left[0] = endpoint(widths[0], widths[1], changes[0], changes[1])
    right[count - 1] = endpoint(widths[count - 1], widths[count - 2], changes[count - 1], changes[count - 2])
    for (let i = 1; i < count; i++) {
      const p = changes[i - 1],
        n = changes[i]
      if (!p || !n || Math.sign(p) !== Math.sign(n)) continue
      const scale = Math.max(widths[i - 1], widths[i])
      const a = widths[i - 1] / scale,
        b = widths[i] / scale
      const denominator = ((2 * b + a) * a) / p + ((b + 2 * a) * b) / n
      right[i - 1] = (3 * (a + b) * a) / denominator
      left[i] = (3 * (a + b) * b) / denominator
    }
  }
  return (x) => {
    if (x <= 0) return x + points[0].y
    if (x >= 1) return x + (points[count].y - 1)
    let low = 0,
      high = count
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2)
      if (x < points[middle].x) high = middle
      else low = middle
    }
    const a = points[low].y,
      b = points[low + 1].y
    const t = (x - points[low].x) / widths[low],
      t2 = t * t,
      t3 = t2 * t
    const y =
      (2 * t3 - 3 * t2 + 1) * a +
      (t3 - 2 * t2 + t) * left[low] +
      (-2 * t3 + 3 * t2) * b +
      (t3 - t2) * right[low]
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), y))
  }
}

function encodedCurves(edit) {
  if (edit.toneCurves === undefined) return null
  const curves = validateToneCurves(edit.toneCurves)
  if (!Object.values(curves).some((points) => !isIdentity(points))) return null
  const master = curves.rgb && !isIdentity(curves.rgb) ? compileCurve(curves.rgb) : null
  const channels = CURVE_CHANNELS.slice(1).map((name) =>
    curves[name] && !isIdentity(curves[name]) ? compileCurve(curves[name]) : null
  )
  return { master, channels }
}

export function createPointCurves(edit = {}) {
  const curves = encodedCurves(edit)
  if (!curves) return null
  return (linear, channel) => {
    const curve = curves.channels[channel]
    if (!curves.master && !curve) return linear
    const original = encodeSrgb(linear)
    let encoded = original
    if (curves.master) encoded = curves.master(encoded)
    if (curve) encoded = curve(encoded)
    return encoded === original ? linear : decodeSrgb(encoded)
  }
}

export function createPointCurveTables(edit = {}) {
  const curves = encodedCurves(edit)
  if (!curves) return null
  return curves.channels.map((curve) =>
    Uint8ClampedArray.from({ length: 256 }, (_, index) => {
      let encoded = index / 255
      if (curves.master) encoded = curves.master(encoded)
      if (curve) encoded = curve(encoded)
      return 255 * encoded
    })
  )
}
