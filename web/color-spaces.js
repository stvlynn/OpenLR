// Independently implemented matrix/TRC spaces. Definitions and validation:
// research/color-transform-experiment.md. This is not a general ICC interpreter.
const D65 = [0.3127 / 0.329, 1, (1 - 0.3127 - 0.329) / 0.329]
// ICC PCS illuminant, exactly the s15Fixed16 values required by ICC.1:2022.
const D50 = [0xf6d6 / 65536, 1, 0xd32d / 65536]
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296]

function multiply(matrix, vector) {
  return [0, 1, 2].map(
    (row) => matrix[row * 3] * vector[0] + matrix[row * 3 + 1] * vector[1] + matrix[row * 3 + 2] * vector[2]
  )
}

function product(left, right) {
  return left.map((_, i) => {
    const row = Math.floor(i / 3),
      col = i % 3
    return (
      left[row * 3] * right[col] + left[row * 3 + 1] * right[col + 3] + left[row * 3 + 2] * right[col + 6]
    )
  })
}

function inverse(m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const cofactors = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d
  ]
  const determinant = a * cofactors[0] + b * cofactors[3] + c * cofactors[6]
  return cofactors.map((value) => value / determinant)
}

function adaptation(white) {
  const source = multiply(BRADFORD, white),
    destination = multiply(BRADFORD, D50)
  const scale = source.map((value, i) => destination[i] / value)
  return product(
    inverse(BRADFORD),
    BRADFORD.map((value, i) => value * scale[Math.floor(i / 3)])
  )
}

function colorants(primaries, white) {
  const columns = primaries.map(([x, y]) => [x / y, 1, (1 - x - y) / y])
  const matrix = [0, 1, 2].flatMap((row) => columns.map((column) => column[row]))
  const scale = multiply(inverse(matrix), white)
  return matrix.map((value, i) => value * scale[i % 3])
}

const DEFINITIONS = {
  srgb: {
    label: 'sRGB',
    primaries: [
      [0.64, 0.33],
      [0.3, 0.6],
      [0.15, 0.06]
    ],
    curve: 'srgb'
  },
  'display-p3': {
    label: 'Display P3',
    primaries: [
      [0.68, 0.32],
      [0.265, 0.69],
      [0.15, 0.06]
    ],
    curve: 'srgb'
  },
  'adobe-rgb': {
    label: 'Adobe RGB',
    primaries: [
      [0.64, 0.33],
      [0.21, 0.71],
      [0.15, 0.06]
    ],
    gamma: 563 / 256
  },
  'prophoto-rgb': {
    label: 'ProPhoto RGB',
    primaries: [
      [0.734699, 0.265301],
      [0.159597, 0.840403],
      [0.036598, 0.000105]
    ],
    curve: 'prophoto',
    d50: true
  },
  rec2020: {
    label: 'Rec.2020 (gamma 2.4 SDR)',
    primaries: [
      [0.708, 0.292],
      [0.17, 0.797],
      [0.131, 0.046]
    ],
    gamma: 2.4
  }
}

export const COLOR_SPACES = Object.freeze(
  Object.fromEntries(
    Object.entries(DEFINITIONS).map(([id, definition]) => [
      id,
      Object.freeze({ id, label: definition.label })
    ])
  )
)

for (const definition of Object.values(DEFINITIONS)) {
  definition.adaptation = definition.d50 ? IDENTITY : adaptation(D65)
  definition.toXYZ = product(
    definition.adaptation,
    colorants(definition.primaries, definition.d50 ? D50 : D65)
  )
  definition.fromXYZ = inverse(definition.toXYZ)
}
const TRANSFORMS = Object.fromEntries(
  Object.entries(DEFINITIONS).map(([source, from]) => [
    source,
    Object.fromEntries(
      Object.entries(DEFINITIONS).map(([target, to]) => [
        target,
        source === target ? IDENTITY : product(to.fromXYZ, from.toXYZ)
      ])
    )
  ])
)

function definitionOf(id) {
  if (!Object.hasOwn(DEFINITIONS, id)) throw new RangeError(`Unknown RGB color space: ${id}`)
  return DEFINITIONS[id]
}

/** Compose a source linear-RGB -> relative D50 XYZ matrix with the existing
 * D50 XYZ -> linear sRGB definition. ICC colorants are already D50-adapted;
 * callers must not apply their chad matrix again. No clipping or quantization.
 */
export function matrixToLinearSrgb(sourceToXyzD50) {
  if (!sourceToXyzD50 || sourceToXyzD50.length !== 9 || !Array.from(sourceToXyzD50).every(Number.isFinite))
    throw new TypeError('RGB matrix must contain nine finite D50 XYZ coefficients')
  return product(DEFINITIONS.srgb.fromXYZ, sourceToXyzD50)
}

/** Normalized encoded named-space input -> signed linear sRGB, without an
 * encoded-sRGB roundtrip. Codecs must establish the source transfer/primaries;
 * a CICP Rec.2020 primary code alone does not identify our gamma-2.4 space.
 */
export function createNamedInputTransform(source = 'srgb') {
  return inputTransform(definitionOf(source), TRANSFORMS[source].srgb)
}

/** Encoded RGB characterized by explicit xy primaries/white and a canonical
 * decode exponent -> linear sRGB. An omitted exponent selects the sRGB curve;
 * the caller owns and records that assumption for incompletely tagged inputs.
 * Reuses the same native-white colorants, Bradford adaptation and target matrix
 * as the named-space owner. PNG gAMA is the reciprocal of this decode exponent.
 */
export function createChromaticInputTransform({ chromaticities, gamma } = {}) {
  if (gamma !== undefined && (!Number.isFinite(gamma) || gamma <= 0))
    throw new TypeError('RGB decode gamma must be finite and positive')
  const definition = gamma === undefined ? { curve: 'srgb' } : { gamma }
  if (!chromaticities) return inputTransform(definition, IDENTITY)
  const points = ['white', 'red', 'green', 'blue'].map((id) => chromaticities[id])
  if (
    !points.every(
      (point) =>
        point?.length === 2 &&
        point.every(Number.isFinite) &&
        point[0] >= 0 &&
        point[1] > 0 &&
        point[0] + point[1] <= 1
    )
  )
    throw new TypeError('Invalid RGB primary or white chromaticity')
  const [whiteXY, ...primaries] = points,
    [x, y] = whiteXY,
    white = [x / y, 1, (1 - x - y) / y],
    source = colorants(primaries, white)
  if (!source.every(Number.isFinite)) throw new TypeError('Invalid or singular RGB chromaticities')
  const matrix = matrixToLinearSrgb(product(adaptation(white), source))
  if (!matrix.every(Number.isFinite)) throw new TypeError('Invalid or singular RGB chromaticities')
  return inputTransform(definition, matrix)
}

function inputTransform(definition, matrix) {
  return {
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
        throw new RangeError('RGB input components must be finite normalized values in [0,1]')
      if (
        !out ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset + 3 > out.length ||
        !(Array.isArray(out) || out instanceof Float32Array || out instanceof Float64Array)
      )
        throw new TypeError('RGB conversion requires float-capable output storage')
      const x = decode(r, definition),
        y = decode(g, definition),
        z = decode(b, definition)
      out[offset] = matrix[0] * x + matrix[1] * y + matrix[2] * z
      out[offset + 1] = matrix[3] * x + matrix[4] * y + matrix[5] * z
      out[offset + 2] = matrix[6] * x + matrix[7] * y + matrix[8] * z
      return out
    }
  }
}

export function decodeSrgb(value) {
  const magnitude = Math.abs(value)
  return magnitude <= 0.04045 ? value / 12.92 : Math.sign(value) * ((magnitude + 0.055) / 1.055) ** 2.4
}

// Exact transfer values for the finite byte domain. Consumers only read this
// shared table; signed/HDR and higher-depth samples still use decodeSrgb.
export const SRGB8_LINEAR = Float64Array.from({ length: 256 }, (_, value) => decodeSrgb(value / 255))

function decode(value, definition) {
  const magnitude = Math.abs(value),
    sign = Math.sign(value)
  if (definition.curve === 'srgb') return decodeSrgb(value)
  if (definition.curve === 'prophoto') return magnitude <= 1 / 32 ? value / 16 : sign * magnitude ** 1.8
  return sign * magnitude ** definition.gamma
}

export function encodeSrgb(value) {
  const magnitude = Math.abs(value)
  return magnitude <= 0.0031308 ? value * 12.92 : Math.sign(value) * (1.055 * magnitude ** (1 / 2.4) - 0.055)
}

function encode(value, definition) {
  const magnitude = Math.abs(value),
    sign = Math.sign(value)
  if (definition.curve === 'srgb') return encodeSrgb(value)
  if (definition.curve === 'prophoto')
    return magnitude <= 1 / 512 ? value * 16 : sign * magnitude ** (1 / 1.8)
  return sign * magnitude ** (1 / definition.gamma)
}

function validateColor(rgb) {
  if (!rgb || rgb.length !== 3 || !Array.from(rgb).every(Number.isFinite))
    throw new TypeError('RGB color must contain three finite normalized components')
}

/** Normalized encoded RGB -> normalized encoded RGB, unbounded, no quantization.
 * Signed extension preserves out-of-gamut and highlight values for float callers.
 * Relative colorimetric Bradford adaptation; no perceptual gamut mapping or BPC.
 */
export function convertRgbColor(rgb, source = 'srgb', target = 'srgb') {
  validateColor(rgb)
  const from = definitionOf(source),
    to = definitionOf(target)
  if (source === target) return Array.from(rgb)
  const linear = Array.from(rgb, (value) => decode(value, from))
  return multiply(TRANSFORMS[source][target], linear).map((value) => encode(value, to))
}

/** Linear-light sRGB -> normalized encoded target; no clipping or quantization. */
export function convertLinearSrgbColor(rgb, target = 'srgb') {
  validateColor(rgb)
  const to = definitionOf(target)
  const linear = target === 'srgb' ? Array.from(rgb) : multiply(TRANSFORMS.srgb[target], rgb)
  return linear.map((value) => encode(value, to))
}

/** Unassociated, 8-bit sRGB RGBA -> unassociated, 8-bit target RGBA.
 * Final conversion clips component values to the representable [0,1] interval.
 * Input data is never changed; alpha is copied without color conversion.
 */
export function convertSrgbPixels({ data, width, height }, target = 'srgb') {
  const to = definitionOf(target)
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    !Number.isSafeInteger(width * height * 4) ||
    !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
    data.length !== width * height * 4
  ) {
    throw new TypeError(
      'Color conversion requires tightly packed 8-bit RGBA pixels and positive integer dimensions'
    )
  }
  const output = new Uint8ClampedArray(data.length)
  if (target === 'srgb') {
    output.set(data)
    return { data: output, width, height }
  }
  const transform = TRANSFORMS.srgb[target]
  const table = SRGB8_LINEAR
  for (let offset = 0; offset < data.length; offset += 4) {
    const linear = multiply(transform, [
      table[data[offset]],
      table[data[offset + 1]],
      table[data[offset + 2]]
    ])
    for (let channel = 0; channel < 3; channel++)
      output[offset + channel] = Math.round(Math.max(0, Math.min(1, encode(linear[channel], to))) * 255)
    output[offset + 3] = data[offset + 3]
  }
  return { data: output, width, height }
}

function signature(view, offset, value) {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, value.charCodeAt(i))
}

function fixed(view, offset, value) {
  view.setInt32(offset, Math.round(value * 65536))
}

function xyzTag(values) {
  const bytes = new Uint8Array(20),
    view = new DataView(bytes.buffer)
  signature(view, 0, 'XYZ ')
  values.forEach((value, i) => fixed(view, 8 + i * 4, value))
  return bytes
}

function textTag(text) {
  const bytes = new Uint8Array(28 + text.length * 2),
    view = new DataView(bytes.buffer)
  signature(view, 0, 'mluc')
  view.setUint32(8, 1)
  view.setUint32(12, 12)
  view.setUint16(16, 0x656e)
  view.setUint16(18, 0x5553)
  view.setUint32(20, text.length * 2)
  view.setUint32(24, 28)
  for (let i = 0; i < text.length; i++) view.setUint16(28 + i * 2, text.charCodeAt(i))
  return bytes
}

function curveTag(definition) {
  const params =
    definition.curve === 'srgb'
      ? [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045]
      : definition.curve === 'prophoto'
        ? [1.8, 1, 0, 1 / 16, 1 / 32]
        : [definition.gamma]
  const bytes = new Uint8Array(12 + params.length * 4),
    view = new DataView(bytes.buffer)
  signature(view, 0, 'para')
  view.setUint16(8, params.length === 1 ? 0 : 3)
  params.forEach((value, i) => fixed(view, 12 + i * 4, value))
  return bytes
}

/** Generate an original ICC v4.3 matrix/TRC RGB display profile matching this module.
 * Colorants are already adapted to D50; chad records the matching Bradford CAT.
 * Deterministic bytes, no Adobe/OS profile data or profile assets are copied.
 */
export function makeColorProfile(target = 'srgb') {
  const definition = definitionOf(target)
  const chad = new Uint8Array(44),
    chadView = new DataView(chad.buffer)
  signature(chadView, 0, 'sf32')
  definition.adaptation.forEach((value, i) => fixed(chadView, 8 + i * 4, value))
  const tags = [
    ['desc', textTag(`OpenLR ${definition.label}`)],
    ['cprt', textTag('OpenLR contributors. AGPL-3.0-only. Independently generated.')],
    ['wtpt', xyzTag(D50)],
    ['chad', chad],
    ...['rXYZ', 'gXYZ', 'bXYZ'].map((id, col) => [
      id,
      xyzTag([definition.toXYZ[col], definition.toXYZ[col + 3], definition.toXYZ[col + 6]])
    ]),
    ...['rTRC', 'gTRC', 'bTRC'].map((id) => [id, curveTag(definition)])
  ]
  let size = 132 + tags.length * 12
  const offsets = tags.map(([, bytes]) => {
    const offset = size
    size += (bytes.length + 3) & ~3
    return offset
  })
  const result = new Uint8Array(size),
    view = new DataView(result.buffer)
  view.setUint32(0, size)
  signature(view, 4, 'OLRC')
  view.setUint32(8, 0x04300000)
  signature(view, 12, 'mntr')
  signature(view, 16, 'RGB ')
  signature(view, 20, 'XYZ ')
  ;[2026, 11, 5, 0, 0, 0].forEach((value, i) => view.setUint16(24 + i * 2, value))
  signature(view, 36, 'acsp')
  view.setUint32(64, 1)
  D50.forEach((value, i) => fixed(view, 68 + i * 4, value))
  signature(view, 80, 'OLRC')
  view.setUint32(128, tags.length)
  tags.forEach(([id, bytes], i) => {
    signature(view, 132 + i * 12, id)
    view.setUint32(136 + i * 12, offsets[i])
    view.setUint32(140 + i * 12, bytes.length)
    result.set(bytes, offsets[i])
  })
  return result
}
