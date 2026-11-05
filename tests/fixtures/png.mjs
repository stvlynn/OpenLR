// Original generated fixtures; independent bitwise CRC and Node zlib encoder.
import { deflateSync } from 'node:zlib'

export function pngChunk(type, payload = new Uint8Array()) {
  const result = new Uint8Array(payload.length + 12),
    view = new DataView(result.buffer)
  view.setUint32(0, payload.length)
  result.set(new TextEncoder().encode(type), 4)
  result.set(payload, 8)
  let crc = 0xffffffff
  for (const byte of result.subarray(4, result.length - 4)) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0)
  return result
}

export function joinPng(parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function integers(values) {
  const bytes = new Uint8Array(values.length * 4),
    view = new DataView(bytes.buffer)
  values.forEach((value, i) => view.setUint32(i * 4, value))
  return bytes
}

function paeth(a, b, c) {
  const prediction = a + b - c,
    distances = [Math.abs(prediction - a), Math.abs(prediction - b), Math.abs(prediction - c)]
  return distances[0] <= distances[1] && distances[0] <= distances[2]
    ? a
    : distances[1] <= distances[2]
      ? b
      : c
}

export function makePngFixture({
  width = 5,
  height = 4,
  bits = 16,
  colorType = 2,
  data,
  interlace = 0,
  filter = 0,
  palette,
  transparency,
  profile,
  srgb,
  gamma,
  chromaticities,
  cicp,
  significantBits,
  exif,
  beforeIdat = [],
  afterIdat = [],
  idatSize = 0,
  rawScanlines,
  compressedData
} = {}) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType],
    maximum = 2 ** bits - 1
  const samples = data
    ? Array.from(data)
    : Array.from({ length: width * height * channels }, (_, i) => (i * 149 + (i % 7) * 256 + 1) & maximum)
  if (samples.length !== width * height * channels)
    throw Error('Fixture sample count does not match dimensions')
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2]
      ]
    : [[0, 0, 1, 1]]
  const rows = []
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = Math.max(0, Math.ceil((width - startX) / stepX)),
      passHeight = Math.max(0, Math.ceil((height - startY) / stepY))
    if (!passWidth || !passHeight) continue
    const stride = Math.ceil((passWidth * channels * bits) / 8),
      bpp = Math.max(1, Math.ceil((channels * bits) / 8))
    let previous = new Uint8Array(stride)
    for (let y = 0; y < passHeight; y++) {
      const row = new Uint8Array(stride),
        view = new DataView(row.buffer)
      for (let x = 0; x < passWidth; x++)
        for (let c = 0; c < channels; c++) {
          const value = samples[((startY + y * stepY) * width + startX + x * stepX) * channels + c],
            sample = x * channels + c
          if (bits === 16) view.setUint16(sample * 2, value)
          else if (bits === 8) row[sample] = value
          else row[Math.floor((sample * bits) / 8)] |= value << (8 - bits - ((sample * bits) % 8))
        }
      const kind = Array.isArray(filter) ? filter[y % filter.length] : filter,
        encoded = new Uint8Array(stride + 1)
      encoded[0] = kind
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0,
          b = previous[i],
          c = i >= bpp ? previous[i - bpp] : 0
        const prediction =
          kind === 1
            ? a
            : kind === 2
              ? b
              : kind === 3
                ? Math.floor((a + b) / 2)
                : kind === 4
                  ? paeth(a, b, c)
                  : 0
        encoded[i + 1] = (row[i] - prediction) & 255
      }
      rows.push(encoded)
      previous = row
    }
  }
  const header = new Uint8Array(13),
    view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([bits, colorType, 0, 0, interlace], 8)
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), pngChunk('IHDR', header)]
  if (cicp) {
    const values = Array.isArray(cicp)
      ? cicp
      : [
          cicp.colorPrimaries,
          cicp.transferCharacteristics,
          cicp.matrixCoefficients ?? 0,
          Number(cicp.fullRange ?? true)
        ]
    parts.push(pngChunk('cICP', Uint8Array.from(values)))
  }
  if (profile)
    parts.push(
      pngChunk(
        'iCCP',
        joinPng([new TextEncoder().encode('Generated RGB\0'), Uint8Array.of(0), deflateSync(profile)])
      )
    )
  if (srgb !== undefined) parts.push(pngChunk('sRGB', Uint8Array.of(srgb)))
  if (gamma !== undefined) parts.push(pngChunk('gAMA', integers([Math.round(gamma * 100000)])))
  if (chromaticities) {
    const values = Array.isArray(chromaticities)
      ? chromaticities
      : [...chromaticities.white, ...chromaticities.red, ...chromaticities.green, ...chromaticities.blue]
    parts.push(pngChunk('cHRM', integers(values.map((v) => Math.round(v * 100000)))))
  }
  if (significantBits) parts.push(pngChunk('sBIT', Uint8Array.from(significantBits)))
  if (exif) parts.push(pngChunk('eXIf', exif))
  if (palette) parts.push(pngChunk('PLTE', Uint8Array.from(palette.flat?.() ?? palette)))
  if (transparency) {
    const values = Array.from(transparency),
      payload = new Uint8Array(values.length * (colorType === 3 ? 1 : 2)),
      v = new DataView(payload.buffer)
    values.forEach((value, i) => (colorType === 3 ? v.setUint8(i, value) : v.setUint16(i * 2, value)))
    parts.push(pngChunk('tRNS', payload))
  }
  for (const [type, payload] of beforeIdat) parts.push(pngChunk(type, payload))
  const scanlines = rawScanlines ?? joinPng(rows),
    compressed = compressedData ?? deflateSync(scanlines),
    chunkSize = idatSize || compressed.length
  for (let i = 0; i < compressed.length; i += chunkSize)
    parts.push(pngChunk('IDAT', compressed.subarray(i, i + chunkSize)))
  for (const [type, payload] of afterIdat) parts.push(pngChunk(type, payload))
  parts.push(pngChunk('IEND'))
  return { bytes: joinPng(parts), samples, scanlines }
}

export const makePng = (options) => makePngFixture(options).bytes
