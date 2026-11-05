import { decodeSrgb, encodeSrgb, convertLinearSrgbColor } from './color-spaces.js'

// Straight alpha, signed and unbounded linear sRGB. Storage owns its samples.
export function isLinearFrame(frame) {
  return frame?.colorSpace === 'srgb-linear' && frame.data instanceof Float32Array
}

function dimensions(frame) {
  if (
    !Number.isSafeInteger(frame?.width) ||
    frame.width < 1 ||
    !Number.isSafeInteger(frame?.height) ||
    frame.height < 1 ||
    !Number.isSafeInteger(frame.width * frame.height * 4) ||
    frame.data?.length !== frame.width * frame.height * 4
  )
    throw new TypeError('Invalid pixel frame dimensions or sample count')
}

export function assertLinearFrame(frame) {
  dimensions(frame)
  if (!isLinearFrame(frame)) throw new TypeError('Expected a linear sRGB Float32 frame')
  for (let i = 0; i < frame.data.length; i++) {
    const value = frame.data[i]
    if (!Number.isFinite(value) || (i % 4 === 3 && (value < 0 || value > 1)))
      throw new TypeError('Invalid linear pixel sample')
  }
  return frame
}

export function rgba8ToLinearFrame(pixels) {
  dimensions(pixels)
  if (!(pixels.data instanceof Uint8Array) && !(pixels.data instanceof Uint8ClampedArray))
    throw new TypeError('Expected RGBA8 samples')
  const data = new Float32Array(pixels.data.length)
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) data[i + c] = decodeSrgb(pixels.data[i + c] / 255)
    data[i + 3] = pixels.data[i + 3] / 255
  }
  return { width: pixels.width, height: pixels.height, data, colorSpace: 'srgb-linear' }
}

// Optional readers consume validated immutable source samples and preserve alpha.
export function linearFrameToRgba8(frame, readPixel = null) {
  if (!readPixel) assertLinearFrame(frame)
  const data = new Uint8ClampedArray(frame.data.length)
  const pixel = readPixel ? new Float32Array(4) : null
  for (let i = 0; i < data.length; i += 4) {
    if (readPixel) readPixel(frame.data, i, pixel, 0)
    for (let c = 0; c < 3; c++) data[i + c] = 255 * encodeSrgb(readPixel ? pixel[c] : frame.data[i + c])
    data[i + 3] = 255 * frame.data[i + 3]
  }
  return { width: frame.width, height: frame.height, data }
}

// Quantize only at the output boundary, after conversion into the target gamut.
export function linearFrameToEncoded(frame, target = 'srgb', bits = 16) {
  assertLinearFrame(frame)
  if (![8, 16].includes(bits)) throw new RangeError('Unsupported output sample depth')
  const data = bits === 16 ? new Uint16Array(frame.data.length) : new Uint8ClampedArray(frame.data.length)
  const maximum = 2 ** bits - 1
  for (let i = 0; i < data.length; i += 4) {
    const rgb = convertLinearSrgbColor(frame.data.subarray(i, i + 3), target)
    for (let c = 0; c < 3; c++) data[i + c] = Math.round(maximum * Math.max(0, Math.min(1, rgb[c])))
    data[i + 3] = Math.round(maximum * frame.data[i + 3])
  }
  return { width: frame.width, height: frame.height, data }
}

// Coordinates name pixel centers. Outside neighbors contribute transparent black.
export function sampleLinearRgba(frame, x, y, out = new Float64Array(4), readPixel = null, pixel = null) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const left = Math.floor(x),
    top = Math.floor(y)
  let coverage = 0,
    alpha = 0
  out.fill(0)
  for (let dy = 0; dy < 2; dy++)
    for (let dx = 0; dx < 2; dx++) {
      const px = left + dx,
        py = top + dy
      if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue
      const weight = (dx ? x - left : 1 - x + left) * (dy ? y - top : 1 - y + top)
      const index = (py * frame.width + px) * 4
      if (readPixel) readPixel(frame.data, index, (pixel ??= new Float32Array(4)), 0)
      const weightedAlpha = weight * frame.data[index + 3]
      coverage += weight
      alpha += weightedAlpha
      for (let c = 0; c < 3; c++) out[c] += (readPixel ? pixel[c] : frame.data[index + c]) * weightedAlpha
    }
  if (!coverage) return null
  if (alpha) for (let c = 0; c < 3; c++) out[c] /= alpha
  out[3] = Math.min(1, Math.max(0, alpha))
  return out
}
