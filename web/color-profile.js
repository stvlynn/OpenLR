// Structural input validation for RGB ICC profiles before handing them to a host CMS.
// ICC.1:2022 sections 7, 10.6, 10.18, 10.23 and 10.32:
// https://www.color.org/specification/ICC.1-2022-05.pdf
// This does not implement a general ICC interpreter or validate arbitrary LUT internals.
const PARAMETER_COUNTS = [1, 3, 4, 5, 7]
const XYZ_TAGS = new Set(['rXYZ', 'gXYZ', 'bXYZ', 'wtpt', 'bkpt', 'lumi'])
const CURVE_TAGS = new Set(['rTRC', 'gTRC', 'bTRC', 'kTRC'])

function invalid(reason) {
  throw Error('Invalid RGB ICC profile: ' + reason)
}

function signature(view, at) {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3)
  )
}

/** Forward ICC.1:2022 table 68 curve, with already validated coefficients.
 * This evaluates normalized unsigned input; named-space signed extensions belong
 * to color-spaces.js and must not be imposed on arbitrary ICC curves.
 */
export function evaluateParametricCurve(type, parameters, x) {
  const [gamma, a, b, c, d, e, f] = parameters
  if (type === 0) return x ** gamma
  // Rounding at x=-b/a can leave a tiny negative residue. Validation checks
  // the real power base over the entire active [0,1] branch before evaluation.
  const power = () => Math.max(0, a * x + b) ** gamma
  if (type <= 2) return x < -b / a ? (type === 2 ? c : 0) : power() + (type === 2 ? c : 0)
  return x < d ? c * x + (type === 4 ? f : 0) : power() + (type === 4 ? e : 0)
}

function validateParametricCurve(view, at, size) {
  if (size < 12) invalid('truncated parametric curve')
  const type = view.getUint16(at + 8),
    count = PARAMETER_COUNTS[type]
  if (count === undefined) invalid('unsupported parametric curve function')
  if (view.getUint16(at + 10) !== 0 || size !== 12 + count * 4) invalid('parametric curve parameter length')
  // ICC para coefficients are signed fixed-point, not IEEE float payloads.
  const parameters = Array.from({ length: count }, (_, i) => view.getInt32(at + 12 + i * 4) / 65536)
  const [gamma, a, b, c, d, e, f] = parameters
  if (!parameters.every(Number.isFinite) || gamma <= 0 || (type > 0 && a <= 0))
    invalid('undefined parametric curve')
  // Check both pieces at their active endpoints and the branch point. With a>0
  // these bound the power base on the complete [0,1] input domain, not a sample grid.
  const threshold = type === 0 ? 0 : type <= 2 ? -b / a : d
  const highStart = Math.max(0, threshold)
  if (type > 0 && highStart <= 1 && a * highStart + b < -1e-12) invalid('negative parametric power base')
  const points = [0, 1]
  if (threshold >= 0 && threshold <= 1) points.push(threshold)
  if (!points.every((x) => Number.isFinite(evaluateParametricCurve(type, parameters, x))))
    invalid('non-finite parametric curve result')
  if (type >= 3) {
    // The lower branch's boundary limit also matters when it differs from the upper branch.
    const lowEnd = Math.min(1, threshold)
    if (lowEnd >= 0 && !Number.isFinite(c * lowEnd + (type === 4 ? f : 0)))
      invalid('non-finite linear curve result')
  }
}

function validatePayload(view, tag) {
  const { id, offset: at, size } = tag,
    type = signature(view, at)
  if (view.getUint32(at + 4) !== 0) invalid('nonzero tag reserved bytes')
  if (XYZ_TAGS.has(id) && (type !== 'XYZ ' || size !== 20)) invalid('invalid XYZ tag layout')
  if (CURVE_TAGS.has(id) && type !== 'curv' && type !== 'para') invalid('invalid tone curve tag type')
  if (id === 'chad' && (type !== 'sf32' || size !== 44)) invalid('invalid chromatic adaptation layout')
  if (type === 'XYZ ') {
    if (size < 20 || (size - 8) % 12 !== 0) invalid('truncated XYZ array')
  } else if (type === 'sf32') {
    if (size < 12 || (size - 8) % 4 !== 0) invalid('truncated fixed-point array')
  } else if (type === 'para') {
    validateParametricCurve(view, at, size)
  } else if (type === 'curv') {
    if (size < 12) invalid('truncated sampled curve')
    const count = view.getUint32(at + 8)
    if (size !== 12 + count * 2) invalid('sampled curve entry length')
    if (count === 1 && view.getUint16(at + 12) === 0) invalid('nonpositive sampled curve gamma')
    // count=0 is identity, count=1 is positive u8Fixed8 gamma, other samples
    // are uInt16 values and therefore finite across their complete encoded range.
  }
}

/** Validate RGB ICC container and known matrix/TRC payload structure.
 * Returns an owned Uint8Array containing exactly the header-declared profile.
 * Shared tag data is legal. Unknown types (including LUTs) receive outer bounds
 * checks only: success is not CMS conformance, renderability, or host support.
 */
export function validateRgbProfile(input) {
  return validateProfile(input, 'RGB ')
}

/** Structural validation only: GRAY interpretation is a separate CMS capability.
 * Keeps malformed gray PNG profiles distinct from valid unsupported profiles.
 */
export function validateGrayProfile(input) {
  try {
    return validateProfile(input, 'GRAY')
  } catch (error) {
    throw Error(error.message.replace(/^Invalid RGB ICC profile:/, 'Invalid GRAY ICC profile:'), {
      cause: error
    })
  }
}

function validateProfile(input, deviceSpace) {
  let bytes
  if (input instanceof ArrayBuffer) bytes = new Uint8Array(input)
  else if (input instanceof Uint8Array || input instanceof Uint8ClampedArray)
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  else invalid('expected profile bytes')
  if (bytes.length < 132) invalid('truncated header')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    size = view.getUint32(0)
  if (size < 132 || size > bytes.length || size % 4 !== 0) invalid('header size')
  if (signature(view, 36) !== 'acsp') invalid('header signature')
  if (signature(view, 16) !== deviceSpace) invalid('unsupported device color space')
  if (!['XYZ ', 'Lab '].includes(signature(view, 20))) invalid('unsupported profile connection space')
  if (![2, 4].includes(view.getUint8(8))) invalid('unsupported ICC version')
  const count = view.getUint32(128),
    tableEnd = 132 + count * 12
  if (count === 0 || tableEnd > size) invalid('tag table bounds')
  const signatures = new Set()
  for (let i = 0; i < count; i++) {
    const at = 132 + i * 12,
      id = signature(view, at),
      offset = view.getUint32(at + 4),
      length = view.getUint32(at + 8)
    if (signatures.has(id)) invalid('duplicate tag signature')
    signatures.add(id)
    if (offset % 4 !== 0 || offset < tableEnd || length < 8 || offset + length > size)
      invalid('tag payload bounds or alignment')
    validatePayload(view, { id, offset, size: length })
  }
  return bytes.slice(0, size)
}
