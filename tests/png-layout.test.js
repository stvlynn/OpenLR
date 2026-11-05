import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync, gzipSync } from 'node:zlib'
import { readPng } from '../web/png.js'
import { pngChunks, pngChunk as sharedChunk } from '../web/png-container.js'
import { encodeColorPng } from '../web/color-containers.js'
import { makeColorProfile } from '../web/color-spaces.js'
import { makePng, makePngFixture, pngChunk, joinPng } from './fixtures/png.mjs'

const layouts = [
  [0, 1],
  [0, 2],
  [0, 4],
  [0, 8],
  [0, 16],
  [2, 8],
  [2, 16],
  [3, 1],
  [3, 2],
  [3, 4],
  [3, 8],
  [4, 8],
  [4, 16],
  [6, 8],
  [6, 16]
]
const channelsFor = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const paletteFor = (bits) =>
  Array.from({ length: 2 ** bits }, (_, i) => [
    (i * 37 + 11) % 256,
    (i * 73 + 13) % 256,
    (i * 109 + 17) % 256
  ]).flat()

function check(options) {
  const palette = options.colorType === 3 ? paletteFor(options.bits) : undefined
  const fixture = makePngFixture({ ...options, palette }),
    original = fixture.bytes.slice(),
    decoded = readPng(fixture.bytes)
  const { samples } = fixture,
    channels = channelsFor[options.colorType],
    maximum = 2 ** options.bits - 1
  assert.equal(decoded.sourceBits, options.colorType === 3 ? 8 : options.bits)
  for (let i = 0; i < options.width * options.height; i++) {
    let expected
    if (options.colorType === 3)
      expected = [...palette.slice(samples[i] * 3, samples[i] * 3 + 3).map((v) => v / 255), 1]
    else if ([0, 4].includes(options.colorType))
      expected = [
        ...Array(3).fill(samples[i * channels] / maximum),
        channels === 2 ? samples[i * channels + 1] / maximum : 1
      ]
    else
      expected = [
        ...samples.slice(i * channels, i * channels + 3).map((v) => v / maximum),
        channels === 4 ? samples[i * channels + 3] / maximum : 1
      ]
    assert.deepEqual(
      Array.from(decoded.data.subarray(i * 4, i * 4 + 4)),
      expected.map(Math.fround),
      JSON.stringify(options) + ' pixel' + i
    )
  }
  assert.deepEqual(fixture.bytes, original)
}

test('all 720 legal PNG depth/type/filter/interlace/dimension cases retain exact normalized source samples', () => {
  let count = 0
  for (const [colorType, bits] of layouts)
    for (const filter of [0, 1, 2, 3, 4, [0, 1, 2, 3, 4]])
      for (const interlace of [0, 1])
        for (const [width, height] of [
          [1, 1],
          [2, 3],
          [9, 9],
          [17, 13]
        ]) {
          check({ colorType, bits, filter, interlace, width, height, idatSize: 7 })
          count++
        }
  assert.equal(count, 720)
})

test('RGBA16 retains low alpha and hidden RGB while 16-bit tRNS compares complete source words', () => {
  const rgba = readPng(
    makePng({
      width: 2,
      height: 1,
      colorType: 6,
      bits: 16,
      data: [1, 2, 3, 0, 65534, 65533, 65532, 1],
      filter: 4,
      interlace: 1
    })
  )
  assert.deepEqual(
    Array.from(rgba.data),
    [1 / 65535, 2 / 65535, 3 / 65535, 0, 65534 / 65535, 65533 / 65535, 65532 / 65535, 1 / 65535].map(
      Math.fround
    )
  )
  const rgb = readPng(
    makePng({
      width: 2,
      height: 1,
      colorType: 2,
      bits: 16,
      data: [257, 258, 259, 257, 258, 260],
      transparency: [257, 258, 259]
    })
  )
  assert.equal(rgb.data[3], 0)
  assert.equal(rgb.data[7], 1)
  assert.ok(rgb.data[0] > 0)
  const gray = readPng(
    makePng({ width: 2, height: 1, colorType: 0, bits: 16, data: [256, 257], transparency: [257] })
  )
  assert.equal(gray.data[3], 1)
  assert.equal(gray.data[7], 0)
  const low = readPng(
    makePng({ width: 2, height: 1, colorType: 0, bits: 2, data: [1, 2], transparency: [65533] })
  )
  assert.equal(low.data[3], 0, 'PNG3 masks unused high tRNS bits')
  assert.equal(low.data[7], 1)
})

test('palette partial alpha defaults to opaque; invalid indexes recover opaque black with an explicit warning', () => {
  const palette = [1, 2, 3, 11, 12, 13],
    p = readPng(
      makePng({ width: 3, height: 1, bits: 2, colorType: 3, data: [0, 1, 2], palette, transparency: [0] })
    )
  assert.deepEqual(
    Array.from(p.data),
    [1 / 255, 2 / 255, 3 / 255, 0, 11 / 255, 12 / 255, 13 / 255, 1, 0, 0, 0, 1].map(Math.fround)
  )
  assert.deepEqual(p.metadata.colorWarnings, ['png-palette-index'])
})

test('owned PNG metadata retains ICC, significant bits and characterizations without changing source words', () => {
  const profile = makeColorProfile('display-p3'),
    exif = Uint8Array.of(73, 73, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  const bytes = makePng({
    width: 1,
    height: 1,
    data: [1025, 2049, 4097],
    profile,
    srgb: 2,
    gamma: 0,
    chromaticities: { white: [0.3127, 0.329], red: [0.64, 0.33], green: [0.3, 0.6], blue: [0.15, 0.06] },
    cicp: [12, 13, 0, 1],
    significantBits: [10, 11, 12],
    exif
  })
  const decoded = readPng(bytes)
  assert.deepEqual(decoded.metadata.icc, profile)
  assert.deepEqual(decoded.metadata.exif, exif)
  assert.deepEqual(decoded.metadata.significantBits, [10, 11, 12])
  assert.equal(decoded.sourceBits, 16)
  assert.equal(decoded.metadata.srgb, 2)
  assert.equal(decoded.metadata.gamma, 0)
  assert.deepEqual(decoded.metadata.colorWarnings, ['png-zero-gamma'])
  assert.deepEqual(decoded.metadata.cicp, {
    colorPrimaries: 12,
    transferCharacteristics: 13,
    matrixCoefficients: 0,
    fullRange: 1
  })
  assert.deepEqual(
    Array.from(decoded.data.slice(0, 3)),
    [1025, 2049, 4097].map((v) => Math.fround(v / 65535))
  )
  bytes.fill(0)
  assert.deepEqual(decoded.metadata.icc, profile)
  assert.deepEqual(decoded.metadata.exif, exif)
})

function parts(bytes) {
  return [...pngChunks(bytes)].map(({ type, data }) => [type, data])
}
function repack(parts) {
  return joinPng([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    ...parts.map(([type, data]) => pngChunk(type, data))
  ])
}

test('signature, CRC, chunk extent/order, unknown critical chunks and invalid pixel layouts fail visibly', () => {
  const valid = makePng(),
    base = parts(valid)
  const badCrc = valid.slice()
  badCrc[badCrc.length - 1] ^= 1
  const badSignature = valid.slice()
  badSignature[0] = 0
  const badExtent = valid.slice()
  new DataView(badExtent.buffer).setUint32(8, 0x7fffffff)
  const invalidHeader = base[0][1].slice()
  invalidHeader[8] = 4
  const oversized = base[0][1].slice(),
    sizeView = new DataView(oversized.buffer)
  sizeView.setUint32(0, 0x7fffffff)
  sizeView.setUint32(4, 0x7fffffff)
  const bads = [
    badCrc,
    badSignature,
    badExtent,
    valid.slice(0, -1),
    repack(base.slice(0, -1)),
    repack([['IHDR', invalidHeader], ...base.slice(1)]),
    repack([['IHDR', oversized], ...base.slice(1)]),
    repack([base[0], base[0], ...base.slice(1)]),
    makePng({ beforeIdat: [['ZBAD', Uint8Array.of(1)]] }),
    repack([base[0], base[1], ['tEXt', Uint8Array.of(1)], base[1], base[2]])
  ]
  for (const bytes of bads) assert.throws(() => readPng(bytes), /PNG/)
  const unknown = readPng(
    makePng({
      beforeIdat: [
        ['vpAg', Uint8Array.of(1, 2, 3)],
        ['vpAg', Uint8Array.of(4)]
      ]
    })
  )
  assert.equal(unknown.width, 5)
})

test('truncated zlib trailers, short/oversized samples, gzip and invalid filters never fabricate pixels', () => {
  const fixture = makePngFixture(),
    compressed = deflateSync(fixture.scanlines)
  for (const compressedData of [
    compressed.subarray(0, -1),
    compressed.subarray(0, -4),
    deflateSync(fixture.scanlines.subarray(0, -1)),
    deflateSync(joinPng([fixture.scanlines, Uint8Array.of(0)])),
    gzipSync(fixture.scanlines)
  ])
    assert.throws(() => readPng(makePng({ compressedData })), /PNG/)
  const badRows = fixture.scanlines.slice()
  badRows[0] = 5
  assert.throws(() => readPng(makePng({ rawScanlines: badRows })), /scanline filter/)
  const padded = readPng(makePng({ compressedData: joinPng([compressed, Uint8Array.of(123, 0, 0)]) }))
  assert.deepEqual(padded.metadata.colorWarnings, ['png-idat-trailing-data'])
})

test('malformed interpreted metadata is rejected, without treating valid unknown CICP as sRGB', () => {
  const bads = [
    makePng({ srgb: 4 }),
    makePng({ cicp: [1, 13, 1, 1] }),
    makePng({ cicp: [1, 13, 0, 2] }),
    makePng({ significantBits: [0, 16, 16] }),
    makePng({ colorType: 6, transparency: [0] }),
    makePng({ beforeIdat: [['gAMA', Uint8Array.of(1)]] }),
    makePng({ gamma: 0.45455, beforeIdat: [['gAMA', new Uint8Array(4)]] }),
    makePng({ beforeIdat: [['iCCP', Uint8Array.of(65, 0, 0, 1, 2, 3)]] }),
    makePng({ beforeIdat: [['mDCV', new Uint8Array(24)]] })
  ]
  for (const bytes of bads) assert.throws(() => readPng(bytes), /PNG/)
  const narrow = readPng(makePng({ cicp: [9, 16, 0, 0] }))
  assert.deepEqual(narrow.metadata.cicp, {
    colorPrimaries: 9,
    transferCharacteristics: 16,
    matrixCoefficients: 0,
    fullRange: 0
  })
})

function animationFixture({
  colorType = 6,
  bits = 16,
  interlace = 0,
  blend = 0,
  includeDefault = false
} = {}) {
  const width = 7,
    height = 6,
    frameWidth = includeDefault ? width : 3,
    frameHeight = includeDefault ? height : 4,
    x = includeDefault ? 0 : 2,
    y = includeDefault ? 0 : 1
  const palette = colorType === 3 ? paletteFor(bits) : undefined
  const options = {
    width: frameWidth,
    height: frameHeight,
    colorType,
    bits,
    interlace,
    filter: [4, 3, 2, 1, 0],
    palette
  }
  const frame = makePngFixture(options),
    actl = new Uint8Array(8),
    fctl = new Uint8Array(26),
    control = new DataView(fctl.buffer)
  new DataView(actl.buffer).setUint32(0, 1)
  control.setUint32(4, frameWidth)
  control.setUint32(8, frameHeight)
  control.setUint32(12, x)
  control.setUint32(16, y)
  fctl[25] = blend
  const zipped = deflateSync(frame.scanlines),
    parts = []
  for (let at = 0, seq = 1; at < zipped.length; at += 7, seq++) {
    const piece = zipped.subarray(at, at + 7),
      payload = new Uint8Array(piece.length + 4)
    new DataView(payload.buffer).setUint32(0, seq)
    payload.set(piece, 4)
    parts.push(['fdAT', payload])
  }
  const bytes = makePng({
    ...options,
    width,
    height,
    data: includeDefault ? frame.samples : undefined,
    beforeIdat: includeDefault
      ? [
          ['acTL', actl],
          ['fcTL', fctl]
        ]
      : [['acTL', actl]],
    afterIdat: includeDefault ? [] : [['fcTL', fctl], ...parts]
  })
  return { bytes, frame: readPng(frame.bytes), width, height, frameWidth, frameHeight, x, y }
}

test('APNG first-frame subrectangles reuse every legal sample layout, Adam7, split fdAT and both blend modes', () => {
  for (const [colorType, bits] of layouts)
    for (const interlace of [0, 1])
      for (const blend of [0, 1]) {
        const f = animationFixture({ colorType, bits, interlace, blend }),
          decoded = readPng(f.bytes)
        assert.equal(decoded.metadata.animated, true)
        assert.equal(decoded.metadata.decodedFrame, 'animation-first')
        for (let y = 0; y < f.height; y++)
          for (let x = 0; x < f.width; x++) {
            const expected =
              x >= f.x && x < f.x + f.frameWidth && y >= f.y && y < f.y + f.frameHeight
                ? Array.from(
                    f.frame.data.subarray(
                      ((y - f.y) * f.frameWidth + x - f.x) * 4,
                      ((y - f.y) * f.frameWidth + x - f.x) * 4 + 4
                    )
                  )
                : [0, 0, 0, 0]
            if (blend === 1 && expected[3] === 0) expected.fill(0)
            assert.deepEqual(
              Array.from(decoded.data.subarray((y * f.width + x) * 4, (y * f.width + x) * 4 + 4)),
              expected
            )
          }
      }
  const included = animationFixture({ includeDefault: true })
  assert.deepEqual(readPng(included.bytes).data, included.frame.data)
})

test('APNG invalid sequence, bounds, operations and missing frame payload reject visibly', () => {
  const valid = parts(animationFixture().bytes)
  for (const mutate of [
    (entries) => {
      entries.find(([type]) => type === 'fcTL')[1][3] = 1
    },
    (entries) => {
      new DataView(entries.find(([type]) => type === 'fcTL')[1].buffer).setUint32(12, 100)
    },
    (entries) => {
      entries.find(([type]) => type === 'fcTL')[1][25] = 2
    },
    (entries) => {
      entries.splice(
        entries.findIndex(([type]) => type === 'fcTL'),
        1
      )
    },
    (entries) => {
      entries.splice(
        entries.findIndex(([type]) => type === 'fdAT'),
        1
      )
    }
  ]) {
    const entries = valid.map(([type, data]) => [type, data.slice()])
    mutate(entries)
    assert.throws(() => readPng(repack(entries)), /PNG/)
  }
})

test('shared PNG chunk extraction preserves the existing writer byte serialization exactly', () => {
  const pixels = {
      width: 3,
      height: 2,
      data: Uint8Array.from({ length: 24 }, (_, i) => (i * 37 + 11) % 256)
    },
    profile = Uint8Array.of(1, 2, 3, 4, 5)
  assert.equal(
    createHash('sha256').update(encodeColorPng(pixels, profile)).digest('hex'),
    'd3981285b21955a6ec5b4ac3c9ed520f9f16dbec4a4de0a665b21ed9fec9dc8e'
  )
  assert.deepEqual(sharedChunk('tEXt', profile), pngChunk('tEXt', profile))
})
