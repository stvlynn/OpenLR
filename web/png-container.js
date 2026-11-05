// Shared PNG container integrity and chunk construction for input and output.
const text = new TextEncoder()
export const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

export function pngCrc(bytes, start = 0, end = bytes.length) {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255]
  return (crc ^ 0xffffffff) >>> 0
}

export function pngChunk(type, payload) {
  const result = new Uint8Array(payload.length + 12),
    view = new DataView(result.buffer)
  view.setUint32(0, payload.length)
  result.set(text.encode(type), 4)
  result.set(payload, 8)
  view.setUint32(result.length - 4, pngCrc(result, 4, result.length - 4))
  return result
}

export function* pngChunks(input, { verifyCrc = true } = {}) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input
  if (!(bytes instanceof Uint8Array) || !PNG_SIGNATURE.every((byte, i) => bytes[i] === byte))
    throw Error('Invalid PNG signature')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 8; offset < bytes.length;) {
    if (bytes.length - offset < 12) throw Error('Truncated PNG chunk header')
    const length = view.getUint32(offset),
      end = offset + length + 12
    if (length > 0x7fffffff || end > bytes.length) throw Error('Invalid PNG chunk extent')
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (!/^[A-Za-z]{4}$/.test(type)) throw Error('Invalid PNG chunk type')
    if (verifyCrc && pngCrc(bytes, offset + 4, end - 4) !== view.getUint32(end - 4))
      throw Error('Invalid PNG ' + type + ' CRC')
    yield { type, data: bytes.subarray(offset + 8, end - 4) }
    offset = end
    if (type === 'IEND') return
  }
}
