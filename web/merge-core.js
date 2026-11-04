const identity = () => [1, 0, 0, 0, 1, 0, 0, 0, 1]
export function multiply(a, b) {
  return Array.from(
    { length: 9 },
    (_, i) =>
      a[Math.floor(i / 3) * 3] * b[i % 3] +
      a[Math.floor(i / 3) * 3 + 1] * b[(i % 3) + 3] +
      a[Math.floor(i / 3) * 3 + 2] * b[(i % 3) + 6]
  )
}
export function project(h, x, y) {
  const z = h[6] * x + h[7] * y + h[8]
  return [(h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z]
}
const linear = (v) => {
  v /= 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const encoded = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

function features(cv, frame) {
  const src = cv.matFromImageData(frame),
    small = new cv.Mat(),
    gray = new cv.Mat(),
    mask = new cv.Mat(),
    keypoints = new cv.KeyPointVector(),
    descriptors = new cv.Mat(),
    orb = new cv.ORB(3500)
  const scale = Math.min(1, 1600 / Math.max(frame.width, frame.height))
  try {
    cv.resize(
      src,
      small,
      new cv.Size(Math.round(frame.width * scale), Math.round(frame.height * scale)),
      0,
      0,
      cv.INTER_AREA
    )
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY)
    cv.equalizeHist(gray, gray)
    orb.setEdgeThreshold(15)
    orb.setFastThreshold(8)
    orb.detectAndCompute(gray, mask, keypoints, descriptors)
    const points = Array.from({ length: keypoints.size() }, (_, i) => {
      const p = keypoints.get(i).pt
      return [p.x / scale, p.y / scale]
    })
    return { points, descriptors, scale }
  } catch (error) {
    descriptors.delete()
    throw error
  } finally {
    src.delete()
    small.delete()
    gray.delete()
    mask.delete()
    keypoints.delete()
    orb.delete()
  }
}

function registration(cv, source, target, sourceFrame, targetFrame) {
  if (source.points.length < 12 || target.points.length < 12)
    throw Error('Not enough image texture for reliable alignment')
  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false),
    matches = new cv.DMatchVectorVector(),
    from = [],
    to = [],
    taken = new Set()
  let src, dst, h, mask
  try {
    matcher.knnMatch(source.descriptors, target.descriptors, matches, 2)
    const candidates = []
    for (let i = 0; i < matches.size(); i++) {
      const pair = matches.get(i)
      if (pair.size() === 2) {
        const a = pair.get(0),
          b = pair.get(1)
        if (a.distance < 0.72 * b.distance && a.distance < 75) candidates.push(a)
      }
      pair.delete()
    }
    candidates.sort((a, b) => a.distance - b.distance)
    for (const match of candidates) {
      if (taken.has(match.trainIdx)) continue
      taken.add(match.trainIdx)
      from.push(...source.points[match.queryIdx])
      to.push(...target.points[match.trainIdx])
    }
    if (from.length < 24) throw Error('Not enough distinct overlapping features')
    src = cv.matFromArray(from.length / 2, 1, cv.CV_32FC2, from)
    dst = cv.matFromArray(to.length / 2, 1, cv.CV_32FC2, to)
    mask = new cv.Mat()
    h = cv.findHomography(src, dst, cv.RANSAC, 3 / Math.min(source.scale, target.scale), mask)
    if (h.empty()) throw Error('Overlapping features did not produce a valid homography')
    const matrix = Array.from(h.data64F),
      inliers = []
    let error = 0
    for (let i = 0; i < mask.data.length; i++)
      if (mask.data[i]) {
        const p = project(matrix, from[i * 2], from[i * 2 + 1])
        error += Math.hypot(p[0] - to[i * 2], p[1] - to[i * 2 + 1])
        inliers.push(i)
      }
    if (inliers.length < 12 || inliers.length / (from.length / 2) < 0.35)
      throw Error('Too few consistent matches; images may not overlap')
    const xs = inliers.map((i) => from[i * 2]),
      ys = inliers.map((i) => from[i * 2 + 1])
    if (
      (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) <
      sourceFrame.width * sourceFrame.height * 0.015
    )
      throw Error('Matches are confined to an unreliable small image region')
    const corners = [
      [0, 0],
      [sourceFrame.width, 0],
      [sourceFrame.width, sourceFrame.height],
      [0, sourceFrame.height]
    ].map(([x, y]) => project(matrix, x, y))
    const denominators = [
      [0, 0],
      [sourceFrame.width, 0],
      [sourceFrame.width, sourceFrame.height],
      [0, sourceFrame.height]
    ].map(([x, y]) => matrix[6] * x + matrix[7] * y + matrix[8])
    if (
      matrix.some((v) => !Number.isFinite(v)) ||
      corners.flat().some((v) => !Number.isFinite(v)) ||
      Math.min(...denominators) * Math.max(...denominators) <= 0
    )
      throw Error('Unstable projective warp; use a narrower field of view')
    const area =
      Math.abs(
        corners.reduce((sum, p, i) => {
          const q = corners[(i + 1) % 4]
          return sum + p[0] * q[1] - q[0] * p[1]
        }, 0)
      ) / 2
    if (
      area < sourceFrame.width * sourceFrame.height * 0.1 ||
      area > targetFrame.width * targetFrame.height * 10
    )
      throw Error('Implausible image scale in alignment')
    return { matrix, inliers: inliers.length, matches: from.length / 2, error: error / inliers.length }
  } finally {
    matcher.delete()
    matches.delete()
    src?.delete()
    dst?.delete()
    h?.delete()
    mask?.delete()
  }
}

function warp(cv, frame, matrix, width, height, weighted = false) {
  const src = cv.matFromImageData(frame),
    dst = new cv.Mat(),
    h = cv.matFromArray(3, 3, cv.CV_64F, matrix)
  let sourceWeight, destWeight, sourceLinear, destLinear
  try {
    cv.warpPerspective(
      src,
      dst,
      h,
      new cv.Size(width, height),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(0, 0, 0, 0)
    )
    const data = new Uint8ClampedArray(dst.data)
    if (!weighted) {
      let linear
      if (frame.linear) {
        sourceLinear = cv.matFromArray(frame.height, frame.width, cv.CV_32FC3, frame.linear)
        destLinear = new cv.Mat()
        cv.warpPerspective(
          sourceLinear,
          destLinear,
          h,
          new cv.Size(width, height),
          cv.INTER_LINEAR,
          cv.BORDER_CONSTANT,
          new cv.Scalar(0, 0, 0)
        )
        linear = new Float32Array(destLinear.data32F)
      }
      return { data, linear }
    }
    sourceWeight = new cv.Mat(frame.height, frame.width, cv.CV_32FC1)
    const feather = Math.max(1, Math.min(frame.width, frame.height) * 0.15)
    for (let y = 0; y < frame.height; y++)
      for (let x = 0; x < frame.width; x++)
        sourceWeight.data32F[y * frame.width + x] =
          Math.min(1, Math.min(x + 1, y + 1, frame.width - x, frame.height - y) / feather) *
          (frame.data[(y * frame.width + x) * 4 + 3] / 255)
    destWeight = new cv.Mat()
    cv.warpPerspective(
      sourceWeight,
      destWeight,
      h,
      new cv.Size(width, height),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(0)
    )
    return { data, weight: new Float32Array(destWeight.data32F) }
  } finally {
    src.delete()
    dst.delete()
    h.delete()
    sourceWeight?.delete()
    destWeight?.delete()
    sourceLinear?.delete()
    destLinear?.delete()
  }
}

export function exposureOffsets(frames, explicit) {
  if (explicit !== undefined) {
    if (
      !Array.isArray(explicit) ||
      explicit.length !== frames.length ||
      explicit.some(
        (v) => typeof v !== 'number' || !Number.isFinite(v) || !Number.isFinite(2 ** v) || 2 ** v === 0
      )
    )
      throw Error('Provide one finite exposure offset (EV) per selected image')
    if (Math.max(...explicit) - Math.min(...explicit) < 1e-6)
      throw Error('HDR requires distinct exposure offsets')
    return [...explicit]
  }
  const exposures = frames.map(({ metadata: m = {} }) => {
    if (
      ![m.ExposureTime, m.FNumber, m.ISO].every((v) => typeof v === 'number' && v > 0 && Number.isFinite(v))
    )
      throw Error('HDR needs exposure time, aperture and ISO on every image, or explicit EV offsets')
    return (m.ExposureTime * m.ISO) / (100 * m.FNumber * m.FNumber)
  })
  return exposureOffsets(
    frames,
    exposures.map((value) => Math.log2(value / exposures[0]))
  )
}

function commonRectangle(aligned, width, height) {
  const heights = new Int32Array(width)
  let best = { x: 0, y: 0, width: 0, height: 0 },
    area = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++)
      heights[x] = aligned.every((frame) => frame.data[(y * width + x) * 4 + 3] >= 254) ? heights[x] + 1 : 0
    const stack = []
    for (let x = 0; x <= width; x++) {
      const value = x === width ? 0 : heights[x]
      while (stack.length && heights[stack.at(-1)] > value) {
        const h = heights[stack.pop()],
          left = stack.length ? stack.at(-1) + 1 : 0,
          w = x - left
        if (h * w > area) {
          area = h * w
          best = { x: left, y: y - h + 1, width: w, height: h }
        }
      }
      stack.push(x)
    }
  }
  return best
}

export function encodeRadiance(radiance, width, height) {
  const header = new TextEncoder().encode(
    '#?RADIANCE\n# OpenLR linear exposure merge\nFORMAT=32-bit_rle_rgbe\n\n-Y ' +
      height +
      ' +X ' +
      width +
      '\n'
  )
  const scan = new Uint8Array(width * 4),
    rle = width >= 8 && width <= 32767
  const result = new Uint8Array(
    header.length + height * (rle ? 4 + 4 * (width + Math.ceil(width / 128)) : width * 4)
  )
  result.set(header)
  let offset = header.length
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3,
        max = Math.max(radiance[i], radiance[i + 1], radiance[i + 2])
      if (max < 1e-32) {
        scan.fill(0, x * 4, x * 4 + 4)
        continue
      }
      const exponent = Math.floor(Math.log2(max)) + 1,
        scale = 256 / 2 ** exponent
      for (let c = 0; c < 3; c++) scan[x * 4 + c] = Math.min(255, Math.floor(radiance[i + c] * scale))
      scan[x * 4 + 3] = exponent + 128
    }
    if (!rle) {
      result.set(scan, offset)
      offset += scan.length
      continue
    }
    result.set([2, 2, width >> 8, width & 255], offset)
    offset += 4
    for (let c = 0; c < 4; c++)
      for (let x = 0; x < width;) {
        const count = Math.min(128, width - x)
        result[offset++] = count
        for (let i = 0; i < count; i++) result[offset++] = scan[(x + i) * 4 + c]
        x += count
      }
  }
  return result
}

function toneMap(radiance, width, height) {
  let logSum = 0,
    min = Infinity,
    max = 0
  const lumas = new Float32Array(width * height)
  for (let i = 0; i < lumas.length; i++) {
    const value = luminance(...radiance.subarray(i * 3, i * 3 + 3))
    lumas[i] = value
    logSum += Math.log(1e-6 + value)
    if (value > 1e-6) min = Math.min(min, value)
    max = Math.max(max, value)
  }
  if (!(max > 0)) throw Error('HDR inputs contain no recoverable light')
  const scale = 0.18 / Math.exp(logSum / lumas.length),
    sorted = Float32Array.from(lumas).sort(),
    white = Math.max(1, sorted[Math.floor(sorted.length * 0.995)] * scale),
    data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < lumas.length; i++) {
    const L = lumas[i],
      scaled = L * scale,
      mapped = (scaled * (1 + scaled / (white * white))) / (1 + scaled),
      factor = L > 0 ? mapped / L : 0
    for (let c = 0; c < 3; c++) data[i * 4 + c] = encoded(radiance[i * 3 + c] * factor)
    data[i * 4 + 3] = 255
  }
  return { data, dynamicRangeStops: Math.log2(max / min), maxRadiance: max, minRadiance: min }
}

export function mergeHDR(cv, frames, options = {}) {
  if (frames.length < 2) throw Error('Select at least two exposure-bracketed photos')
  const evs = exposureOffsets(frames, options.evs),
    indices = evs.map((ev, i) => i).sort((a, b) => evs[a] - evs[b]),
    reference = indices[Math.floor(indices.length / 2)]
  const base = frames[reference],
    align = options.align !== false,
    diagnostics = []
  const factors = evs.map((ev) => 2 ** (ev - evs[reference]))
  if (factors.some((value) => !Number.isFinite(value) || value === 0))
    throw Error('Exposure span exceeds the representable floating-point range')
  const feats = align ? frames.map((frame) => features(cv, frame)) : []
  try {
    const aligned = frames.map((frame, i) => {
      let matrix = identity()
      if (i !== reference) {
        if (align) {
          const found = registration(cv, feats[i], feats[reference], frame, base)
          matrix = found.matrix
          diagnostics.push({ source: i, target: reference, ...found })
        } else if (frame.width !== base.width || frame.height !== base.height)
          throw Error('Tripod HDR without alignment requires equal image dimensions')
      }
      return warp(cv, frame, matrix, base.width, base.height)
    })
    const crop = commonRectangle(aligned, base.width, base.height)
    if (crop.width * crop.height < base.width * base.height * 0.5)
      throw Error('HDR images do not share enough aligned image area')
    const radiance = new Float32Array(crop.width * crop.height * 3)
    let inconsistent = 0,
      measured = 0,
      recoverable = 0,
      clipped = 0
    for (let y = 0; y < crop.height; y++)
      for (let x = 0; x < crop.width; x++) {
        const src = ((crop.y + y) * base.width + crop.x + x) * 4,
          dst = (y * crop.width + x) * 3
        for (let c = 0; c < 3; c++) {
          let sum = 0,
            total = 0,
            best = 0,
            bestWeight = -1
          const estimates = []
          for (let i = 0; i < aligned.length; i++) {
            const z = aligned[i].data[src + c] / 255,
              w = Math.min(z, 1 - z),
              value =
                (aligned[i].linear?.[(src / 4) * 3 + c] ?? linear(aligned[i].data[src + c])) / factors[i]
            if (w > bestWeight) {
              bestWeight = w
              best = value
            }
            if (z > 0.01 && z < 0.99) {
              sum += w * value
              total += w
              estimates.push(value)
            }
          }
          if (estimates.length > 1) {
            measured++
            const mean = estimates.reduce((a, b) => a + b, 0) / estimates.length
            if (mean > 0.005 && Math.max(...estimates) - Math.min(...estimates) > mean * 0.6) inconsistent++
          }
          const value = total ? sum / total : best
          if (!Number.isFinite(value) || value > 3.402823466e38)
            throw Error('Recovered radiance exceeds the 32-bit floating-point range')
          radiance[dst + c] = value
          if (total) recoverable++
          else clipped++
        }
      }
    if (measured && inconsistent / measured > 0.12)
      throw Error('Exposure-normalized pixels disagree; check EV offsets, moving subjects or alignment')
    if (!recoverable) throw Error('All source exposures are clipped; no radiance can be recovered')
    const mapped = toneMap(radiance, crop.width, crop.height)
    return {
      width: crop.width,
      height: crop.height,
      data: mapped.data,
      radiance: encodeRadiance(radiance, crop.width, crop.height),
      diagnostics: {
        kind: 'hdr',
        method: 'calibrated linear radiance + Reinhard tone mapping',
        inputTransfer: frames.map((frame) => (frame.linear ? 'linear16-RAW' : 'sRGB inverse transfer')),
        evs,
        reference,
        crop,
        alignment: diagnostics,
        dynamicRangeStops: mapped.dynamicRangeStops,
        maxRadiance: mapped.maxRadiance,
        minRadiance: mapped.minRadiance,
        inconsistentFraction: measured ? inconsistent / measured : 0,
        unrecoverableChannelFraction: clipped / (clipped + recoverable)
      }
    }
  } finally {
    for (const feat of feats) feat.descriptors.delete()
  }
}

export function mergePanorama(cv, frames) {
  if (frames.length < 2) throw Error('Select at least two overlapping photos')
  const feats = frames.map((frame) => features(cv, frame)),
    transforms = [identity()],
    alignment = [],
    rejectedPairs = []
  try {
    for (let i = 1; i < frames.length; i++) {
      let best
      for (let j = 0; j < i; j++)
        try {
          const found = registration(cv, feats[i], feats[j], frames[i], frames[j])
          if (!best || found.inliers > best.inliers) best = { ...found, target: j, source: i }
        } catch (error) {
          rejectedPairs.push({ source: i, target: j, message: error.message || String(error) })
        }
      if (!best)
        throw Error(
          'Photo ' +
            (i + 1) +
            ' has no reliable overlapping match: ' +
            rejectedPairs
              .filter((pair) => pair.source === i)
              .map((pair) => pair.message)
              .join('; ')
        )
      transforms.push(multiply(transforms[best.target], best.matrix))
      alignment.push(best)
    }
    const corners = frames.flatMap((frame, i) =>
      [
        [0, 0],
        [frame.width, 0],
        [frame.width, frame.height],
        [0, frame.height]
      ].map(([x, y]) => project(transforms[i], x, y))
    )
    const left = Math.floor(Math.min(...corners.map((p) => p[0]))),
      top = Math.floor(Math.min(...corners.map((p) => p[1]))),
      right = Math.ceil(Math.max(...corners.map((p) => p[0]))),
      bottom = Math.ceil(Math.max(...corners.map((p) => p[1])))
    const width = right - left,
      height = bottom - top
    if (!Number.isSafeInteger(width * height) || width <= 0 || height <= 0)
      throw Error('Invalid panorama bounds from projective alignment')
    const sums = new Float32Array(width * height * 3),
      weights = new Float32Array(width * height),
      translation = [1, 0, -left, 0, 1, -top, 0, 0, 1]
    for (let i = 0; i < frames.length; i++) {
      const image = warp(cv, frames[i], multiply(translation, transforms[i]), width, height, true)
      for (let p = 0; p < weights.length; p++) {
        const w = image.weight[p] * (image.data[p * 4 + 3] / 255)
        if (w <= 0) continue
        weights[p] += w
        for (let c = 0; c < 3; c++) sums[p * 3 + c] += linear(image.data[p * 4 + c]) * w
      }
    }
    const data = new Uint8ClampedArray(width * height * 4)
    for (let p = 0; p < weights.length; p++)
      if (weights[p] > 0) {
        for (let c = 0; c < 3; c++) data[p * 4 + c] = encoded(sums[p * 3 + c] / weights[p])
        data[p * 4 + 3] = 255
      }
    return {
      width,
      height,
      data,
      diagnostics: {
        kind: 'panorama',
        method: 'ORB + Hamming ratio + RANSAC projective alignment + linear-light feather blend',
        projection: 'perspective',
        transforms,
        bounds: { left, top, right, bottom },
        alignment,
        rejectedPairs
      }
    }
  } finally {
    for (const feat of feats) feat.descriptors.delete()
  }
}
