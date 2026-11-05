import { LENS_DATA } from './lens-data.js'
import { multiply, project } from './merge-core.js'
import { assertLinearFrame, sampleLinearRgba } from './pixel-frame.js'
import { SRGB8_LINEAR as linear } from './color-spaces.js'

export const OPTICS_CONTROLS = {
  manualDistortion: { label: 'Distortion', range: [-100, 100, 1], initial: 0 },
  redScale: { label: 'Red / cyan TCA', range: [-100, 100, 1], initial: 0 },
  blueScale: { label: 'Blue / yellow TCA', range: [-100, 100, 1], initial: 0 },
  vertical: { label: 'Vertical perspective', range: [-50, 50, 0.1], initial: 0 },
  horizontal: { label: 'Horizontal perspective', range: [-50, 50, 0.1], initial: 0 },
  rotate: { label: 'Straighten angle (°)', range: [-180, 180, 0.1], initial: 0 },
  shear: { label: 'Horizontal skew (°)', range: [-30, 30, 0.1], initial: 0 },
  scale: { label: 'Scale (%)', range: [10, 400, 0.1], initial: 100 },
  aspect: { label: 'Aspect (%)', range: [25, 400, 0.1], initial: 100 },
  shiftX: { label: 'X offset (%)', range: [-100, 100, 0.1], initial: 0 },
  shiftY: { label: 'Y offset (%)', range: [-100, 100, 0.1], initial: 0 }
}
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/corporation|incorporated|inc\.?/g, '')
    .replace(/[^a-z0-9]/g, '')
const finite = (v, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw Error(name + ' must be finite')
  return v
}
const object = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Expected optics settings object')
  return value
}

export function listLensProfiles(query = '') {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  return LENS_DATA.profiles
    .filter((profile) =>
      terms.every((term) => (profile.maker + ' ' + profile.model).toLowerCase().includes(term))
    )
    .map(({ id, maker, model, cropFactor, distortion, tca }) => ({
      id,
      maker,
      model,
      cropFactor,
      distortion: distortion.length > 0,
      tca: tca.length > 0
    }))
}
export function matchLensProfiles(metadata = {}) {
  const make = normalize(metadata.Make),
    model = normalize(metadata.Model),
    lens = normalize(metadata.LensModel)
  const cameras = LENS_DATA.cameras.filter(
    (camera) =>
      (!make || normalize(camera.maker) === make) &&
      camera.aliases.some((alias) => normalize(alias) === model)
  )
  const stripMaker = (name, maker) => normalize(name).replace(new RegExp('^' + normalize(maker)), '')
  const profiles = LENS_DATA.profiles.filter((profile) => {
    if (lens)
      return profile.aliases.some(
        (alias) =>
          normalize(alias) === lens ||
          stripMaker(alias, profile.maker) === stripMaker(metadata.LensModel, profile.maker)
      )
    return (
      cameras.length === 1 && profile.mounts.includes(cameras[0].mount) && /\(standard\)/i.test(profile.model)
    )
  })
  return {
    cameras,
    profiles: listLensProfiles().filter((profile) => profiles.some((item) => item.id === profile.id)),
    source: LENS_DATA.metadata
  }
}
function interpolate(samples, focal) {
  if (!samples.length) return null
  const sorted = [...samples].sort((a, b) => a.focal - b.focal)
  if (focal < sorted[0].focal - 1e-5 || focal > sorted.at(-1).focal + 1e-5) return null
  const right = sorted.find((sample) => sample.focal >= focal - 1e-5) ?? sorted.at(-1),
    left = sorted[Math.max(0, sorted.indexOf(right) - 1)]
  if (Math.abs(right.focal - focal) < 1e-5) return { ...right, sampleRange: [right.focal, right.focal] }
  if (left.model !== right.model) throw Error('Cannot interpolate different Lensfun calibration models')
  const t = (focal - left.focal) / (right.focal - left.focal),
    result = { model: left.model, focal, sampleRange: [left.focal, right.focal] }
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
    if (key !== 'model' && key !== 'focal') {
      const initial = ['kr', 'kb', 'vr', 'vb'].includes(key) ? 1 : 0
      result[key] = (left[key] ?? initial) * (1 - t) + (right[key] ?? initial) * t
    }
  return result
}
export function lensProfile(id, focal, cropFactor) {
  const source = LENS_DATA.profiles.find((profile) => profile.id === id)
  if (!source) throw Error('Lens profile not found in the bundled database')
  finite(focal, 'Focal length')
  if (focal <= 0) throw Error('Focal length must be positive')
  cropFactor = cropFactor ?? source.cropFactor
  finite(cropFactor, 'Crop factor')
  if (cropFactor < source.cropFactor - 1e-4)
    throw Error(
      'This profile was calibrated for crop factor ' + source.cropFactor + ' or smaller sensor areas'
    )
  const distortion = interpolate(source.distortion, focal),
    tca = interpolate(source.tca, focal)
  if (!distortion && !tca) throw Error('Focal length is outside the profile calibration range')
  return {
    id: source.id,
    maker: source.maker,
    model: source.model,
    focal,
    cropFactor,
    calibrationCrop: source.cropFactor,
    aspectRatio: source.aspectRatio,
    distortion,
    tca,
    source: source.source,
    sourceCommit: LENS_DATA.metadata.commit,
    license: LENS_DATA.metadata.license
  }
}
function calibration(value, kind) {
  if (value === null) return null
  object(value)
  const keys =
    kind === 'distortion'
      ? ['model', 'focal', 'sampleRange', 'real-focal', 'a', 'b', 'c', 'k1', 'k2']
      : ['model', 'focal', 'sampleRange', 'kr', 'kb', 'br', 'cr', 'vr', 'bb', 'cb', 'vb']
  const models = kind === 'distortion' ? ['poly3', 'poly5', 'ptlens'] : ['linear', 'poly3']
  if (Object.keys(value).some((key) => !keys.includes(key)) || !models.includes(value.model))
    throw Error('Unsupported lens ' + kind + ' calibration')
  for (const [key, number] of Object.entries(value))
    if (!['model', 'sampleRange'].includes(key)) finite(number, 'Profile ' + key)
  if (
    value.sampleRange &&
    (!Array.isArray(value.sampleRange) ||
      value.sampleRange.length !== 2 ||
      value.sampleRange.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
  )
    throw Error('Invalid calibration sample range')
  return structuredClone(value)
}
export function validateOptics(value) {
  object(value)
  const result = {}
  for (const [key, v] of Object.entries(value)) {
    if (Object.hasOwn(OPTICS_CONTROLS, key)) {
      finite(v, key)
      const [min, max] = OPTICS_CONTROLS[key].range
      if (v < min || v > max) throw Error(key + ' must be between ' + min + ' and ' + max)
      result[key] = v
    } else if (['enabled', 'profileDistortion', 'profileTCA'].includes(key)) {
      if (typeof v !== 'boolean') throw Error(key + ' must be boolean')
      result[key] = v
    } else if (key === 'profile') {
      if (v === null) {
        result.profile = null
        continue
      }
      object(v)
      const fields = [
        'id',
        'maker',
        'model',
        'focal',
        'cropFactor',
        'calibrationCrop',
        'aspectRatio',
        'distortion',
        'tca',
        'source',
        'sourceCommit',
        'license'
      ]
      if (Object.keys(v).some((name) => !fields.includes(name))) throw Error('Unknown lens profile property')
      for (const name of ['id', 'maker', 'model', 'source', 'sourceCommit', 'license'])
        if (typeof v[name] !== 'string') throw Error('Invalid lens profile ' + name)
      for (const name of ['focal', 'cropFactor', 'calibrationCrop', 'aspectRatio'])
        if (!(finite(v[name], name) > 0)) throw Error('Invalid lens profile ' + name)
      if (v.cropFactor < v.calibrationCrop - 1e-4)
        throw Error('Profile calibration does not cover this sensor size')
      result.profile = {
        ...v,
        distortion: calibration(v.distortion, 'distortion'),
        tca: calibration(v.tca, 'tca')
      }
    } else throw Error('Unknown optics parameter: ' + key)
  }
  return result
}
function inverse(a) {
  const [A, B, C, D, E, F, G, H, I] = a,
    d = A * (E * I - F * H) - B * (D * I - F * G) + C * (D * H - E * G)
  if (Math.abs(d) < 1e-10) throw Error('Singular geometry transform')
  return [
    (E * I - F * H) / d,
    (C * H - B * I) / d,
    (B * F - C * E) / d,
    (F * G - D * I) / d,
    (A * I - C * G) / d,
    (C * D - A * F) / d,
    (D * H - E * G) / d,
    (B * G - A * H) / d,
    (A * E - B * D) / d
  ]
}
export function compileOptics(image, value = {}) {
  const recipe = validateOptics(value),
    short = Math.min(image.width, image.height),
    rx = image.width / short,
    ry = image.height / short
  const enabled = recipe.enabled !== false,
    profile = enabled ? recipe.profile : null
  const v = (key) => (enabled ? (recipe[key] ?? OPTICS_CONTROLS[key].initial) : OPTICS_CONTROLS[key].initial)
  const angle = (v('rotate') * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle),
    scale = v('scale') / 100,
    aspect = v('aspect') / 100
  const transform = multiply(
    [1, 0, (v('shiftX') / 100) * rx * 2, 0, 1, (v('shiftY') / 100) * ry * 2, 0, 0, 1],
    multiply(
      [c, -s, 0, s, c, 0, 0, 0, 1],
      multiply(
        [scale * aspect, 0, 0, 0, scale, 0, 0, 0, 1],
        multiply(
          [1, Math.tan((v('shear') * Math.PI) / 180), 0, 0, 1, 0, 0, 0, 1],
          [1, 0, 0, 0, 1, 0, v('horizontal') / 200, v('vertical') / 200, 1]
        )
      )
    )
  )
  const backward = inverse(transform),
    ratio = profile
      ? ((profile.calibrationCrop / profile.cropFactor) * Math.hypot(profile.aspectRatio, 1)) /
        Math.hypot(Math.max(image.width, image.height) / short, 1)
      : 1
  const distortion = recipe.profileDistortion !== false ? profile?.distortion : null,
    tca = recipe.profileTCA !== false ? profile?.tca : null
  const manual = v('manualDistortion') / 1000,
    red = 1 + v('redScale') / 10000,
    blue = 1 + v('blueScale') / 10000
  function radial(r) {
    const z = r * ratio
    let factor = 1
    if (distortion?.model === 'poly3') {
      const k = distortion.k1 ?? 0,
        d = 1 - k
      factor += (k / d ** 3) * z * z
    } else if (distortion?.model === 'poly5')
      factor += (distortion.k1 ?? 0) * z * z + (distortion.k2 ?? 0) * z ** 4
    else if (distortion?.model === 'ptlens') {
      const a = distortion.a ?? 0,
        b = distortion.b ?? 0,
        c = distortion.c ?? 0,
        d = 1 - a - b - c
      factor += (a / d ** 4) * z ** 3 + (b / d ** 3) * z * z + (c / (d * d)) * z
    }
    const mapped = r * factor
    return mapped * (1 + manual * mapped * mapped)
  }
  function tcaFactor(r, channel) {
    let factor = 1
    if (channel !== 1 && tca) {
      const side = channel === 0 ? 'r' : 'b',
        z = r * ratio
      factor =
        tca.model === 'linear'
          ? (tca['k' + side] ?? 1)
          : (tca['b' + side] ?? 0) * z * z + (tca['c' + side] ?? 0) * z + (tca['v' + side] ?? 1)
    }
    return factor * (channel === 0 ? red : channel === 2 ? blue : 1)
  }
  const corners = [
    [-rx, -ry],
    [rx, -ry],
    [rx, ry],
    [-rx, ry]
  ]
  let radius = Math.hypot(rx, ry)
  for (const h of [transform, backward])
    for (const [x, y] of corners) {
      if (h[6] * x + h[7] * y + h[8] <= 0.05)
        throw Error('Perspective crosses the image horizon; reduce the transform')
      if (h === backward) radius = Math.max(radius, Math.hypot(...project(h, x, y)))
    }
  let previous = 0,
    previousRed = 0,
    previousBlue = 0
  for (let i = 1; i <= 128; i++) {
    const r = (radius * i) / 128,
      d = radial(r)
    const mappedRed = d * tcaFactor(d, 0),
      mappedBlue = d * tcaFactor(d, 2)
    if (
      !Number.isFinite(d) ||
      d <= previous ||
      !Number.isFinite(mappedRed) ||
      !Number.isFinite(mappedBlue) ||
      mappedRed <= previousRed ||
      mappedBlue <= previousBlue
    )
      throw Error('Lens parameters produce a folded or invalid image; reduce distortion or perspective')
    previous = d
    previousRed = mappedRed
    previousBlue = mappedBlue
  }
  const active =
    enabled &&
    Boolean(
      distortion || tca || Object.keys(OPTICS_CONTROLS).some((key) => v(key) !== OPTICS_CONTROLS[key].initial)
    )
  const normalized = (x, y) => ({ x: x / (2 * rx) + 0.5, y: y / (2 * ry) + 0.5 })
  function toOriginal(point, channel = 1) {
    const [x, y] = project(backward, (point.x - 0.5) * 2 * rx, (point.y - 0.5) * 2 * ry),
      r = Math.hypot(x, y),
      rd = radial(r),
      factor = (r ? rd / r : 1) * tcaFactor(rd, channel)
    return normalized(x * factor, y * factor)
  }
  function fromOriginal(point) {
    const x = (point.x - 0.5) * 2 * rx,
      y = (point.y - 0.5) * 2 * ry,
      r = Math.hypot(x, y)
    if (!r) return normalized(...project(transform, 0, 0))
    let low = 0,
      high = Math.max(1, r),
      last = 0
    for (let i = 0; i < 20 && radial(high) < r; i++) {
      if (radial(high) <= last) return null
      last = radial(high)
      high *= 1.3
    }
    if (radial(high) < r) return null
    for (let i = 0; i < 45; i++) {
      const middle = (low + high) / 2
      if (radial(middle) < r) low = middle
      else high = middle
    }
    const factor = (low + high) / (2 * r)
    return normalized(...project(transform, x * factor, y * factor))
  }
  return { active, toOriginal, fromOriginal, transform, inverse: backward }
}

const encode = (value) => 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055)
export function warpOptics(pixels, recipe, reference = pixels) {
  const mapping = compileOptics(reference, recipe)
  if (!mapping.active) return pixels
  const { width, height, data } = pixels,
    result = new Uint8ClampedArray(data.length)
  let alpha = 0
  function sample(x, y, channel) {
    const ix = Math.floor(x),
      iy = Math.floor(y),
      fx = x - ix,
      fy = y - iy
    let value = 0
    alpha = 0
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const sx = ix + dx,
          sy = iy + dy
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue
        const i = (sy * width + sx) * 4,
          weight = ((dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * data[i + 3]) / 255
        value += linear[data[i + channel]] * weight
        alpha += weight
      }
    return alpha ? encode(value / alpha) : 0
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const point = { x: (x + 0.5) / width, y: (y + 0.5) / height },
        i = (y * width + x) * 4
      let minimumAlpha = 1
      for (let channel = 0; channel < 3; channel++) {
        const p = mapping.toOriginal(point, channel)
        result[i + channel] = sample(p.x * width - 0.5, p.y * height - 0.5, channel)
        minimumAlpha = Math.min(minimumAlpha, alpha)
      }
      result[i + 3] = minimumAlpha * 255
    }
  return { width, height, data: result }
}
// Same spatial map as the byte renderer and tools; only sample storage/domain
// changes. Separate channel locations retain conservative TCA edge coverage.
export function warpOpticsFrame(frame, recipe, reference = frame) {
  assertLinearFrame(frame)
  const mapping = compileOptics(reference, recipe)
  if (!mapping.active) return frame
  const { width, height } = frame,
    data = new Float32Array(frame.data.length),
    sample = new Float64Array(4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const point = { x: (x + 0.5) / width, y: (y + 0.5) / height },
        offset = (y * width + x) * 4
      let alpha = 1
      for (let channel = 0; channel < 3; channel++) {
        const p = mapping.toOriginal(point, channel),
          found = sampleLinearRgba(frame, p.x * width - 0.5, p.y * height - 0.5, sample)
        data[offset + channel] = found ? sample[channel] : 0
        alpha = Math.min(alpha, found ? sample[3] : 0)
      }
      data[offset + 3] = alpha
    }
  return { ...frame, data }
}
export function renderOpticsSource(image, recipe, reference = image, maxEdge = Infinity) {
  if (!compileOptics(reference, recipe).active) return image
  const canvas = document.createElement('canvas'),
    scale = Math.min(1, maxEdge / Math.max(image.width, image.height))
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  const pixels = warpOptics(ctx.getImageData(0, 0, canvas.width, canvas.height), recipe, reference)
  ctx.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0)
  return canvas
}
export function straighten(image, recipe, start, end, axis = 'horizontal') {
  if (!['horizontal', 'vertical'].includes(axis))
    throw Error('Expected a horizontal or vertical reference axis')
  const map = compileOptics(image, recipe),
    a = map.fromOriginal(start),
    b = map.fromOriginal(end)
  if (!a || !b || Math.hypot((a.x - b.x) * image.width, (a.y - b.y) * image.height) < 2)
    throw Error('Choose two distinct points on a real image line')
  const angle = (Math.atan2((b.y - a.y) * image.height, (b.x - a.x) * image.width) * 180) / Math.PI
  let delta = (axis === 'vertical' ? 90 : 0) - angle
  while (delta > 90) delta -= 180
  while (delta < -90) delta += 180
  let rotate = (recipe?.rotate ?? 0) + delta
  while (rotate > 180) rotate -= 360
  while (rotate < -180) rotate += 360
  return validateOptics({ ...recipe, rotate })
}
