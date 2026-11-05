// View-only composition geometry, in crop-frame CSS pixels. Never part of an edit recipe.
export const CROP_GUIDES = {
  none: 'None',
  grid: 'Grid',
  thirds: 'Thirds',
  fifths: 'Fifths',
  diagonal: 'Diagonal',
  center: 'Center',
  triangle: 'Triangle',
  'golden-ratio': 'Golden ratio',
  'golden-spiral': 'Golden spiral',
  'aspect-ratios': 'Aspect ratios'
}
export const CROP_GUIDE_MESSAGES = {
  label: 'Composition guide',
  orientation: 'Guide orientation',
  orientations: ['Default', 'Mirror horizontal', 'Mirror vertical', 'Mirror both'],
  invalid: 'Invalid crop guide',
  description: 'Composition guides (view only)'
}
const phi = (1 + Math.sqrt(5)) / 2

export function cropGuideGeometry(type, width, height, orientation = 0) {
  if (
    !Object.hasOwn(CROP_GUIDES, type) ||
    !Number.isInteger(orientation) ||
    orientation < 0 ||
    orientation > 3
  )
    throw Error(CROP_GUIDE_MESSAGES.invalid)
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)))
    return { paths: [], labels: [] }
  const paths = [],
    labels = []
  const line = (x1, y1, x2, y2) =>
    paths.push([
      [x1, y1],
      [x2, y2]
    ])
  const divisions = (values) => {
    for (const f of values) {
      line(width * f, 0, width * f, height)
      line(0, height * f, width, height * f)
    }
  }
  if (['grid', 'thirds', 'fifths'].includes(type)) {
    const n = { grid: 8, thirds: 3, fifths: 5 }[type]
    divisions(Array.from({ length: n - 1 }, (_, i) => (i + 1) / n))
  } else if (type === 'center') divisions([0.5])
  else if (type === 'golden-ratio') divisions([1 - 1 / phi, 1 / phi])
  else if (type === 'diagonal') {
    const side = Math.min(width, height)
    line(0, 0, side, side)
    line(width, 0, width - side, side)
    line(0, height, side, height - side)
    line(width, height, width - side, height - side)
  } else if (type === 'triangle') {
    line(0, 0, width, height)
    const d = width * width + height * height
    const t = (width * width) / d,
      u = (height * height) / d
    line(width, 0, width * t, height * t)
    line(0, height, width * u, height * u)
  } else if (type === 'golden-spiral') {
    // A true logarithmic spiral: radius grows by phi for each quarter turn.
    // Uniform fitting preserves angles on every crop aspect, rather than stretching it.
    const points = Array.from({ length: 481 }, (_, i) => {
      const theta = (i / 480 - 1) * Math.PI * 6
      const radius = Math.exp((theta * Math.log(phi) * 2) / Math.PI)
      return [radius * Math.cos(theta), radius * Math.sin(theta)]
    })
    const xs = points.map(([x]) => x),
      ys = points.map(([, y]) => y)
    const minX = Math.min(...xs),
      minY = Math.min(...ys)
    const w = Math.max(...xs) - minX,
      h = Math.max(...ys) - minY
    const scale = Math.min(width / w, height / h)
    paths.push(
      points.map(([x, y]) => [
        (width - w * scale) / 2 + (x - minX) * scale,
        (height - h * scale) / 2 + (y - minY) * scale
      ])
    )
  } else if (type === 'aspect-ratios') {
    for (const [ratio, label] of [
      [1, '1:1'],
      [4 / 5, '4:5'],
      [3 / 2, '3:2'],
      [16 / 9, '16:9']
    ]) {
      const w = Math.min(width, height * ratio),
        h = w / ratio
      const x = (width - w) / 2,
        y = (height - h) / 2
      paths.push([
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
        [x, y]
      ])
      labels.push({ x: x + 5, y: y + 13, text: label })
    }
  }
  if (type === 'triangle' || type === 'golden-spiral')
    for (const path of paths)
      for (const point of path) {
        if (orientation & 1) point[0] = width - point[0]
        if (orientation & 2) point[1] = height - point[1]
      }
  return { paths, labels }
}

export function cropGuidePath(paths) {
  return paths
    .map((points) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`).join(' '))
    .join(' ')
}
