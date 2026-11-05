import { encodeSrgb } from './color-spaces.js'

let byteTable
// A 20-bit prefix leaves 12 Float32 bits per bucket (520,194 table bytes).
const shift = 12
const scalarBucket = 256

function makeByteTable() {
  const table = new Uint16Array((0x3f800000 >>> shift) + 1)
  const sample = new Float32Array(1),
    bits = new Uint32Array(sample.buffer)
  const byte = new Uint8ClampedArray(1)
  for (let index = 0; index < table.length; index++) {
    bits[0] = index * 2 ** shift
    byte[0] = 255 * encodeSrgb(sample[0])
    const first = byte[0]
    bits[0] += 2 ** shift - 1
    byte[0] = 255 * encodeSrgb(sample[0])
    // Only constant quantized buckets bypass the scalar transfer. Buckets
    // crossing a byte boundary retain its exact clamped, ties-to-even rounding.
    table[index] = first === byte[0] ? first : scalarBucket
  }
  return table
}

// The caller supplies Float32 samples, including the rounded scratch output of
// a pixel reader. This is an sRGB RGBA8 boundary, not a general transfer curve.
export function createSrgbByteReader(samples) {
  const table = (byteTable ??= makeByteTable())
  const bits = new Uint32Array(samples.buffer, samples.byteOffset, samples.length)
  const byte = new Uint8ClampedArray(1)
  return (index) => {
    const value = samples[index]
    if (!(value > 0)) return 0
    if (value >= 1) return 255
    const code = table[bits[index] >>> shift]
    if (code !== scalarBucket) return code
    byte[0] = 255 * encodeSrgb(value)
    return byte[0]
  }
}
