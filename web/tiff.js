import UTIF from './vendor/codecs/utif.js'

export function readTiff(bytes) {
  const header = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength))
  if (
    header.length < 8 ||
    !(
      (header[0] === 73 && header[1] === 73 && header[2] === 42 && header[3] === 0) ||
      (header[0] === 77 && header[1] === 77 && header[2] === 0 && header[3] === 42)
    )
  )
    throw Error('Invalid or unsupported TIFF header')
  const image = UTIF.decode(bytes).find((ifd) => ifd.t256?.[0] > 0 && ifd.t257?.[0] > 0)
  if (!image) throw Error('No TIFF image was found')
  if (image.t50706 || image.t262?.[0] === 32803) throw Error('A sensor DNG must use the RAW decoder')
  const interpretation = image.t262?.[0] ?? 2,
    bits = image.t258?.[0] ?? 1,
    fillOrder = image.t266?.[0] ?? 1,
    compression = image.t259?.[0] ?? 1,
    predictor = image.t317?.[0] ?? 1
  if (
    ![0, 1, 2, 3, 5].includes(interpretation) ||
    (image.t339?.[0] ?? 1) !== 1 ||
    image.t284?.[0] === 2 ||
    ![1, 2, 4, 8, 16].includes(bits) ||
    (interpretation === 3 && bits !== 8)
  )
    throw Error('Unsupported TIFF pixel layout')
  if (![1, 2].includes(predictor) || (predictor === 2 && bits < 8)) throw Error('Unsupported TIFF predictor')
  // TIFF 6 p32 confines unambiguous FillOrder=2 to bilevel uncompressed/CCITT.
  // UTIF's G3/G4 bit readers already consume that ordering and write MSB-first
  // pixels; reverse only ordinary uncompressed bytes after the shared decode.
  if (
    ![1, 2].includes(fillOrder) ||
    (fillOrder === 2 &&
      (bits !== 1 ||
        (image.t277?.[0] ?? 1) !== 1 ||
        ![0, 1].includes(interpretation) ||
        ![1, 3, 4].includes(compression)))
  )
    throw Error('Unsupported TIFF fill order')
  UTIF.decodeImage(bytes, image)
  if (fillOrder === 2 && compression === 1)
    for (let i = 0; i < image.data.length; i++) {
      let value = image.data[i]
      value = ((value & 0x55) << 1) | ((value >>> 1) & 0x55)
      value = ((value & 0x33) << 2) | ((value >>> 2) & 0x33)
      image.data[i] = (value << 4) | (value >>> 4)
    }
  return image
}

// UTIF normalizes decoded 16-bit strips/tiles to little endian, including MM
// sources. Read samples before toRGBA8 discards their low bytes.
export function tiffEncodedPixels(image) {
  const { width, height } = image,
    bits = image.t258?.[0] ?? 1,
    photo = image.t262?.[0] ?? 2,
    channels = image.t277?.[0] ?? (photo === 2 ? 3 : 1)
  if (
    !Number.isSafeInteger(width) ||
    width < 1 ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    !Number.isSafeInteger(width * height * 4)
  )
    throw Error('Invalid TIFF pixel dimensions')
  if (
    (image.t258 ?? [bits]).some((value) => value !== bits) ||
    (image.t339 ?? [1]).some((value) => value !== 1)
  )
    throw Error('Unsupported mixed TIFF sample layout')
  if (photo === 5) return { reason: 'tiff-cmyk' }
  if (
    (photo === 2 && ![3, 4].includes(channels)) ||
    ([0, 1].includes(photo) && ![1, 2].includes(channels)) ||
    (photo === 3 && channels !== 1)
  )
    throw Error('Unsupported TIFF channel layout')
  const rowBytes = Math.ceil((width * channels * bits) / 8)
  if (image.data.length !== rowBytes * height) throw Error('Invalid TIFF decoded sample count')
  const bytes = image.data,
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    maximum = 2 ** bits - 1,
    data = new Float32Array(width * height * 4),
    alphaType = image.t338?.[0],
    hasAlpha = (photo === 2 ? channels === 4 : channels === 2) && [1, 2].includes(alphaType),
    palette = image.t320
  if (photo === 3 && (!palette || palette.length !== 3 * (maximum + 1))) throw Error('Invalid TIFF color map')
  const sample = (x, y, channel) => {
    const bit = (x * channels + channel) * bits,
      offset = y * rowBytes + Math.floor(bit / 8)
    if (bits === 16) return view.getUint16(offset, true)
    if (bits === 8) return bytes[offset]
    return (bytes[offset] >> (8 - bits - (bit % 8))) & maximum
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4,
        alpha = hasAlpha ? sample(x, y, channels - 1) / maximum : 1
      data[offset + 3] = alpha
      for (let c = 0; c < 3; c++) {
        let value
        if (photo === 3) value = palette[c * (maximum + 1) + sample(x, y, 0)] / 65535
        else {
          value = sample(x, y, photo === 2 ? c : 0) / maximum
          if (photo === 0) value = 1 - value
        }
        data[offset + c] = hasAlpha && alphaType === 1 ? (alpha ? value / alpha : 0) : value
      }
    }
  return { width, height, data, sourceBits: photo === 3 ? 16 : bits }
}

export function orientTiffPixels(pixels, orientation) {
  if (!orientation || orientation === 1) return pixels
  const { width, height, data } = pixels,
    swapped = orientation >= 5 && orientation <= 8,
    w = swapped ? height : width,
    h = swapped ? width : height,
    out = new data.constructor(w * h * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let u = x,
        v = y
      if (orientation === 2) u = width - 1 - x
      if (orientation === 3) {
        u = width - 1 - x
        v = height - 1 - y
      }
      if (orientation === 4) v = height - 1 - y
      if (orientation === 5) {
        u = y
        v = x
      }
      if (orientation === 6) {
        u = height - 1 - y
        v = x
      }
      if (orientation === 7) {
        u = height - 1 - y
        v = width - 1 - x
      }
      if (orientation === 8) {
        u = y
        v = width - 1 - x
      }
      out.set(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (v * w + u) * 4)
    }
  return { ...pixels, width: w, height: h, data: out }
}
