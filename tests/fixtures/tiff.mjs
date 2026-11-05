import { deflateSync } from 'node:zlib'

function generate({
  width = 5,
  height = 4,
  bits = 16,
  channels = 3,
  photo = 2,
  le = true,
  compression = 1,
  predictor = 1,
  tile = 0,
  rows = 2,
  alpha = 0,
  data,
  profile,
  orientation = 1,
  colorMap,
  padLastStrip = false
} = {}) {
  const max = 2 ** bits - 1,
    samples = data
      ? Array.from(data)
      : Array.from({ length: width * height * channels }, (_, i) => (i * 149 + (i % 7) * 256 + 1) & max)
  if (samples.length !== width * height * channels)
    throw Error('Fixture samples must match dimensions/channels')
  if (alpha && !data)
    for (let i = channels - 1; i < samples.length; i += channels)
      samples[i] = i % 3 ? Math.floor(max / 2) + 1 : 0
  const blocks = []
  const blocksAcross = tile ? Math.ceil(width / tile) : 1,
    blocksDown = tile ? Math.ceil(height / tile) : Math.ceil(height / rows)
  for (let by = 0; by < blocksDown; by++)
    for (let bx = 0; bx < blocksAcross; bx++) {
      const bw = tile || width,
        bh = tile || (padLastStrip ? rows : Math.min(rows, height - by * rows)),
        vals = []
      for (let y = 0; y < bh; y++)
        for (let x = 0; x < bw; x++)
          for (let c = 0; c < channels; c++) {
            const sx = bx * bw + x,
              sy = by * (tile || rows) + y
            vals.push(sx < width && sy < height ? samples[(sy * width + sx) * channels + c] : 0)
          }
      if (predictor === 2)
        for (let y = 0; y < bh; y++)
          for (let x = bw - 1; x > 0; x--)
            for (let c = 0; c < channels; c++) {
              const i = (y * bw + x) * channels + c
              vals[i] = (vals[i] - vals[i - channels]) & max
            }
      const raw = new Uint8Array(vals.length * (bits / 8)),
        dv = new DataView(raw.buffer)
      vals.forEach((v, i) => (bits === 16 ? dv.setUint16(i * 2, v, le) : dv.setUint8(i, v)))
      if (compression === 8) blocks.push(new Uint8Array(deflateSync(raw)))
      else if (compression === 32773) {
        const out = []
        for (let i = 0; i < raw.length; i += 128) {
          const size = Math.min(128, raw.length - i)
          out.push(size - 1, ...raw.subarray(i, i + size))
        }
        blocks.push(Uint8Array.from(out))
      } else if (compression === 5) {
        // Literal-only TIFF early-change LZW, exercising 9/10/11/12-bit widths.
        const codes = [[256, 9]]
        let width = 9,
          next = 258,
          first = true
        for (const value of raw) {
          codes.push([value, width])
          if (!first) {
            next++
            if (next + 1 === 2 ** width && width < 12) width++
          }
          first = false
          if (next === 4094) {
            codes.push([256, width])
            width = 9
            next = 258
            first = true
          }
        }
        codes.push([257, width])
        const packed = new Uint8Array(Math.ceil(codes.reduce((total, [, size]) => total + size, 0) / 8))
        let at = 0
        codes.forEach(([v, size]) => {
          for (let b = 0; b < size; b++, at++)
            if ((v >> (size - 1 - b)) & 1) packed[at >> 3] |= 1 << (7 - (at & 7))
        })
        blocks.push(packed)
      } else blocks.push(raw)
    }
  const tags = [
    [256, 4, [width]],
    [257, 4, [height]],
    [258, 3, Array(channels).fill(bits)],
    [259, 3, [compression]],
    [262, 3, [photo]],
    [277, 3, [channels]],
    [284, 3, [1]],
    [317, 3, [predictor]],
    [339, 3, Array(channels).fill(1)]
  ]
  tags.push([274, 3, [orientation]])
  if (profile?.length) tags.push([34675, 7, Array.from(profile)])
  if (colorMap?.length) tags.push([320, 3, Array.from(colorMap)])
  if (alpha) tags.push([338, 3, [alpha]])
  if (tile)
    tags.push(
      [322, 4, [tile]],
      [323, 4, [tile]],
      [324, 4, blocks.map(() => 0)],
      [325, 4, blocks.map((b) => b.length)]
    )
  else tags.push([273, 4, blocks.map(() => 0)], [278, 4, [rows]], [279, 4, blocks.map((b) => b.length)])
  tags.sort((a, b) => a[0] - b[0])
  let cursor = 8 + 2 + tags.length * 12 + 4
  const entries = tags.map(([id, type, values]) => {
    const size = values.length * (type === 7 ? 1 : type === 3 ? 2 : 4),
      offset = size > 4 ? cursor : null
    if (size > 4) cursor += size + (size % 2)
    return { id, type, values, size, offset }
  })
  const offsets = []
  blocks.forEach((b) => {
    offsets.push(cursor)
    cursor += b.length
  })
  entries.find((t) => t.id === (tile ? 324 : 273)).values = offsets
  const bytes = new Uint8Array(cursor),
    dv = new DataView(bytes.buffer)
  bytes.set(le ? [73, 73, 42, 0] : [77, 77, 0, 42])
  dv.setUint32(4, 8, le)
  dv.setUint16(8, tags.length, le)
  entries.forEach((t, i) => {
    const at = 10 + i * 12
    dv.setUint16(at, t.id, le)
    dv.setUint16(at + 2, t.type, le)
    dv.setUint32(at + 4, t.values.length, le)
    if (t.offset !== null) dv.setUint32(at + 8, t.offset, le)
    t.values.forEach((v, j) =>
      t.type === 7
        ? dv.setUint8((t.offset ?? at + 8) + j, v)
        : t.type === 3
          ? dv.setUint16((t.offset ?? at + 8) + j * 2, v, le)
          : dv.setUint32((t.offset ?? at + 8) + j * 4, v, le)
    )
  })
  blocks.forEach((b, i) => bytes.set(b, offsets[i]))
  return { bytes, samples }
}

export function makeTiffFixture(options = {}) {
  return generate({
    ...options,
    le: options.littleEndian ?? true,
    tile: options.tileSize ?? 0,
    rows: options.rowsPerStrip ?? 2
  })
}
export function makeTiff(options = {}) {
  return makeTiffFixture(options).bytes
}
