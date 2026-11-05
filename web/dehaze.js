import { assertLinearFrame } from './pixel-frame.js'

export const DEHAZE_MESSAGES = {
  label: 'Dehaze',
  invalid: 'Dehaze must be a number between -100 and 100',
  analysis: 'Dehaze analysis does not match this image',
  nonfinite: 'Dehaze produced a non-finite pixel sample'
}

const clamp = (value) => Math.max(0, Math.min(1, value))
const proxyLuminance = (data, index) =>
  0.2126 * clamp(data[index * 4]) + 0.7152 * clamp(data[index * 4 + 1]) + 0.0722 * clamp(data[index * 4 + 2])

// Separable clipped-border minima. Infinity means no visible evidence.
function minimum(values, temporary, width, height, radius) {
  const queue = new Float64Array(Math.max(width, height))
  const pass = (length, lines, stride, lineStride, input, output) => {
    for (let line = 0; line < lines; line++) {
      const base = line * lineStride
      let head = 0,
        tail = 0,
        end = -1
      for (let position = 0; position < length; position++) {
        const limit = Math.min(length - 1, position + radius)
        while (end < limit) {
          end++
          const value = input[base + end * stride]
          while (tail > head && input[base + queue[tail - 1] * stride] >= value) tail--
          queue[tail++] = end
        }
        while (head < tail && queue[head] < position - radius) head++
        output[base + position * stride] = input[base + queue[head] * stride]
      }
    }
  }
  pass(width, height, 1, width, values, temporary)
  pass(height, width, width, 1, temporary, values)
}

// A min-heap retains the top k dark-channel values without sorting N objects.
// The weakest tied entry has the latest raster index, so selection is stable.
function airlight(data, dark, visible) {
  const capacity = Math.max(1, Math.ceil(visible * 0.001))
  const scores = new Float32Array(capacity),
    indices = new Float64Array(capacity)
  let size = 0
  const worse = (a, b) => scores[a] < scores[b] || (scores[a] === scores[b] && indices[a] > indices[b])
  const swap = (a, b) => {
    const score = scores[a],
      index = indices[a]
    scores[a] = scores[b]
    indices[a] = indices[b]
    scores[b] = score
    indices[b] = index
  }
  for (let index = 0; index < dark.length; index++) {
    if (!data[index * 4 + 3]) continue
    const score = dark[index]
    if (size < capacity) {
      let item = size++
      scores[item] = score
      indices[item] = index
      while (item > 0) {
        const parent = Math.floor((item - 1) / 2)
        if (!worse(item, parent)) break
        swap(item, parent)
        item = parent
      }
    } else if (score > scores[0] || (score === scores[0] && index < indices[0])) {
      scores[0] = score
      indices[0] = index
      let item = 0
      while (2 * item + 1 < size) {
        let child = 2 * item + 1
        if (child + 1 < size && worse(child + 1, child)) child++
        if (!worse(child, item)) break
        swap(item, child)
        item = child
      }
    }
  }
  let selected = indices[0],
    luminance = proxyLuminance(data, selected)
  for (let i = 1; i < size; i++) {
    const index = indices[i],
      value = proxyLuminance(data, index)
    if (value > luminance || (value === luminance && index < selected)) {
      selected = index
      luminance = value
    }
  }
  return [0, 1, 2].map((channel) => Math.max(1e-4, clamp(data[selected * 4 + channel])))
}

// Fused weighted moments with a rolling row ring. Only horizontal sums within
// the current vertical support are retained. Compensated Float64 accumulation
// keeps tiny alpha weights from disappearing as large weights leave a window.
function boxMoments(width, height, radius, channels, sample, emit) {
  const rowSize = width * channels,
    rows = Math.min(height, 2 * radius + 1)
  const ring = new Float64Array(rowSize * rows)
  const vertical = new Float64Array(rowSize),
    correction = new Float64Array(rowSize)
  const values = new Float64Array(channels),
    sums = new Float64Array(channels),
    errors = new Float64Array(channels)
  const add = (totals, residuals, index, value) => {
    const previous = totals[index],
      next = previous + value
    residuals[index] +=
      Math.abs(previous) >= Math.abs(value) ? previous - next + value : value - next + previous
    totals[index] = next
  }
  const row = (y) => {
    sums.fill(0)
    errors.fill(0)
    const start = y * width,
      slot = (y % rows) * rowSize
    const accumulate = (x, sign) => {
      sample(start + x, values)
      for (let c = 0; c < channels; c++) add(sums, errors, c, sign * values[c])
    }
    for (let x = 0; x <= Math.min(radius, width - 1); x++) accumulate(x, 1)
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) ring[slot + x * channels + c] = sums[c] + errors[c]
      if (x - radius >= 0) accumulate(x - radius, -1)
      if (x + radius + 1 < width) accumulate(x + radius + 1, 1)
    }
  }
  const verticalRow = (y, sign) => {
    const slot = (y % rows) * rowSize
    for (let index = 0; index < rowSize; index++) add(vertical, correction, index, sign * ring[slot + index])
  }
  let end = -1
  for (let y = 0; y < height; y++) {
    while (end < Math.min(height - 1, y + radius)) {
      end++
      row(end)
      verticalRow(end, 1)
    }
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) values[c] = vertical[x * channels + c] + correction[x * channels + c]
      emit(y * width + x, values)
    }
    if (y - radius >= 0) verticalRow(y - radius, -1)
  }
}

export function analyzeDehaze(frame, { transmission = true } = {}) {
  assertLinearFrame(frame)
  const { width, height, data } = frame,
    count = width * height
  const radius = Math.max(2, Math.round(0.007 * Math.min(width, height)))
  const refinementRadius = Math.max(3, Math.round(0.02 * Math.min(width, height)))
  let visible = 0,
    black = true
  for (let index = 0; index < count; index++) {
    if (!data[index * 4 + 3]) continue
    visible++
    if (data[index * 4] > 0 || data[index * 4 + 1] > 0 || data[index * 4 + 2] > 0) black = false
  }
  const result = {
    width,
    height,
    radius,
    refinementRadius,
    visible,
    black,
    airlight: [1, 1, 1],
    transmission: null
  }
  if (!visible || black) return result
  const dark = new Float32Array(count)
  let minimumTemporary = new Float32Array(count)
  for (let index = 0; index < count; index++)
    dark[index] = data[index * 4 + 3]
      ? Math.min(clamp(data[index * 4]), clamp(data[index * 4 + 1]), clamp(data[index * 4 + 2]))
      : Infinity
  minimum(dark, minimumTemporary, width, height, radius)
  result.airlight = airlight(data, dark, visible)
  if (!transmission) return result
  for (let index = 0; index < count; index++)
    dark[index] = data[index * 4 + 3]
      ? Math.min(
          Math.max(0, data[index * 4]) / result.airlight[0],
          Math.max(0, data[index * 4 + 1]) / result.airlight[1],
          Math.max(0, data[index * 4 + 2]) / result.airlight[2]
        )
      : Infinity
  minimum(dark, minimumTemporary, width, height, radius)
  for (let index = 0; index < count; index++) dark[index] = 1 - 0.95 * clamp(dark[index])

  minimumTemporary = null
  // Two Float32 planes and a clipped row ring are live during refinement.
  // At 6000x4000/r=80, the five-moment ring is 38.64 MB rather than N*5 planes.
  const coefficient = new Float32Array(count)
  boxMoments(
    width,
    height,
    refinementRadius,
    5,
    (index, values) => {
      const alpha = data[index * 4 + 3],
        guide = proxyLuminance(data, index),
        t = dark[index]
      values[0] = alpha
      values[1] = alpha * guide
      values[2] = alpha * t
      values[3] = alpha * guide * guide
      values[4] = alpha * guide * t
    },
    (index, values) => {
      const support = values[0]
      if (support <= 0) {
        coefficient[index] = 0
        dark[index] = 1
        return
      }
      const guide = values[1] / support,
        t = values[2] / support
      const variance = Math.max(0, values[3] / support - guide * guide)
      const a = (values[4] / support - guide * t) / (variance + 1e-4)
      coefficient[index] = a
      // This row's coarse values were consumed into the ring before emission.
      dark[index] = t - a * guide
    }
  )
  boxMoments(
    width,
    height,
    refinementRadius,
    3,
    (index, values) => {
      const alpha = data[index * 4 + 3]
      values[0] = alpha
      values[1] = alpha * coefficient[index]
      values[2] = alpha * dark[index]
    },
    (index, values) => {
      dark[index] =
        values[0] > 0
          ? Math.max(0.1, Math.min(1, (values[1] * proxyLuminance(data, index) + values[2]) / values[0]))
          : 1
    }
  )
  result.transmission = dark
  return result
}

function validateAmount(amount) {
  if (!Number.isFinite(amount) || amount < -100 || amount > 100) throw Error(DEHAZE_MESSAGES.invalid)
}

export function createDehazePixel(amount = 0, analysis) {
  validateAmount(amount)
  if (
    amount !== 0 &&
    (!analysis ||
      !Array.isArray(analysis.airlight) ||
      analysis.airlight.length !== 3 ||
      !analysis.airlight.every(Number.isFinite) ||
      (amount > 0 && analysis.visible && !analysis.black && !analysis.transmission))
  )
    throw Error(DEHAZE_MESSAGES.analysis)
  const identity = amount === 0 || !analysis.visible || (amount > 0 && analysis.black)
  const air = analysis?.black && amount < 0 ? [1, 1, 1] : analysis?.airlight
  const strength = amount / 100,
    veil = -strength * 0.6
  return (data, sourceOffset, output, targetOffset = 0) => {
    const alpha = data[sourceOffset + 3]
    const t =
      !identity && alpha && amount > 0 ? 1 - strength * (1 - analysis.transmission[sourceOffset / 4]) : 1
    if (identity || !alpha || (amount > 0 && t === 1)) {
      for (let c = 0; c < 4; c++) output[targetOffset + c] = data[sourceOffset + c]
      return output
    }
    for (let c = 0; c < 3; c++) {
      const value = Math.fround(
        amount > 0
          ? air[c] + (data[sourceOffset + c] - air[c]) / t
          : (1 - veil) * data[sourceOffset + c] + veil * air[c]
      )
      if (!Number.isFinite(value)) throw Error(DEHAZE_MESSAGES.nonfinite)
      output[targetOffset + c] = value
    }
    output[targetOffset + 3] = alpha
    return output
  }
}

export function dehazeFrame(frame, amount = 0, analysis) {
  validateAmount(amount)
  if (amount === 0) return frame
  assertLinearFrame(frame)
  let map = analysis ?? analyzeDehaze(frame, { transmission: amount > 0 })
  if (
    map.width !== frame.width ||
    map.height !== frame.height ||
    !Array.isArray(map.airlight) ||
    map.airlight.length !== 3 ||
    !map.airlight.every(Number.isFinite) ||
    (map.transmission && map.transmission.length !== frame.width * frame.height)
  )
    throw Error(DEHAZE_MESSAGES.analysis)
  if (!map.visible || (amount > 0 && map.black)) return frame
  if (amount > 0 && !map.transmission) map = analyzeDehaze(frame)
  const data = frame.data,
    apply = createDehazePixel(amount, map)
  for (let index = 0; index < frame.width * frame.height; index++) {
    const offset = index * 4
    apply(data, offset, data, offset)
  }
  return assertLinearFrame(frame)
}
