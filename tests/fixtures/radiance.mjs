import assert from 'node:assert/strict'

// Independent reader for OpenLR's RGBE scanline format, including literal and
// run packets. For widths outside the scanline range it reads raw RGBE tuples.
export function decodeRadiance(input) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const formatEnd = bytes.indexOf('\n\n')
  assert.ok(formatEnd >= 0, 'Missing Radiance header terminator')
  const header = bytes.subarray(0, formatEnd).toString('ascii')
  assert.ok(header.startsWith('#?RADIANCE\n'))
  assert.ok(header.split('\n').includes('FORMAT=32-bit_rle_rgbe'))
  const shapeEnd = bytes.indexOf(10, formatEnd + 2)
  assert.ok(shapeEnd > formatEnd, 'Missing Radiance resolution')
  const shape = /^-Y ([1-9]\d*) \+X ([1-9]\d*)$/.exec(
    bytes.subarray(formatEnd + 2, shapeEnd).toString('ascii')
  )
  assert.ok(shape, 'Unexpected Radiance orientation or resolution')
  const height = Number(shape[1]),
    width = Number(shape[2]),
    rle = width >= 8 && width <= 32767,
    rowMinimum = rle ? 4 + 8 * Math.ceil(width / 127) : width * 4
  let offset = shapeEnd + 1
  assert.ok(Number.isSafeInteger(width * height * 3))
  assert.ok(height * rowMinimum <= bytes.length - offset, 'Radiance image exceeds its encoded data')
  const pixels = new Float32Array(width * height * 3)
  const row = new Uint8Array(width * 4)
  for (let y = 0; y < height; y++) {
    if (!rle) {
      assert.ok(offset + row.length <= bytes.length, 'Incomplete raw RGBE scanline')
      row.set(bytes.subarray(offset, offset + row.length))
      offset += row.length
    } else {
      assert.ok(offset + 4 <= bytes.length, 'Incomplete RGBE scanline header')
      assert.equal(bytes.readUInt16BE(offset), 0x0202)
      assert.equal(bytes.readUInt16BE(offset + 2), width)
      offset += 4
      for (let c = 0; c < 4; c++)
        for (let x = 0; x < width;) {
          assert.ok(offset < bytes.length, 'Missing RGBE packet')
          const packet = bytes[offset++],
            count = packet > 128 ? packet - 128 : packet
          assert.ok(count > 0 && x + count <= width, 'Invalid RGBE packet length')
          if (packet > 128) {
            assert.ok(offset < bytes.length, 'Missing RGBE run sample')
            const sample = bytes[offset++]
            for (let i = 0; i < count; i++) row[(x + i) * 4 + c] = sample
          } else {
            assert.ok(offset + count <= bytes.length, 'Incomplete RGBE literal packet')
            for (let i = 0; i < count; i++) row[(x + i) * 4 + c] = bytes[offset++]
          }
          x += count
        }
    }
    for (let x = 0; x < width; x++) {
      const exponent = row[x * 4 + 3],
        factor = exponent ? 2 ** (exponent - 136) : 0
      for (let c = 0; c < 3; c++) pixels[(y * width + x) * 3 + c] = row[x * 4 + c] * factor
    }
  }
  assert.equal(offset, bytes.length, 'Unexpected data after the last RGBE scanline')
  return { width, height, pixels }
}
