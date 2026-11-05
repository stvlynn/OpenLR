import pako from './vendor/codecs/pako.js'
import { pngChunks } from './png-container.js'

const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2]
]
const COLOR_CHUNKS = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'sBIT', 'mDCV', 'cLLI'])

function invalid(reason) {
  throw Error('Invalid PNG: ' + reason)
}
function exact(data, length, type) {
  if (data.length !== length) invalid(type + ' length')
}
function dataView(data) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}
function safeSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid('sample dimensions exceed representable range')
  return value
}

function profileBytes(data) {
  const separator = data.indexOf(0)
  if (separator < 1 || separator > 79 || separator + 2 >= data.length || data[separator + 1] !== 0)
    invalid('iCCP name or compression')
  let previous = 0
  for (const byte of data.subarray(0, separator)) {
    if (!((byte >= 32 && byte <= 126) || byte >= 161) || (byte === 32 && (previous === 0 || previous === 32)))
      invalid('iCCP profile name')
    previous = byte
  }
  if (previous === 32) invalid('iCCP profile name')
  const inflater = new pako.Inflate({ windowBits: 15 })
  inflater.push(data.subarray(separator + 2), false)
  if (inflater.err || !inflater.ended || inflater.strm.avail_in) invalid('iCCP compressed stream')
  return inflater.result
}

function paeth(a, b, c) {
  const p = a + b - c,
    da = Math.abs(p - a),
    db = Math.abs(p - b),
    dc = Math.abs(p - c)
  return da <= db && da <= dc ? a : db <= dc ? b : c
}

// Decode the static image or first APNG animation frame through the same rows.
// Samples remain encoded and straight;
// color characterization and EXIF orientation belong to their shared adapters.
export function readPng(input) {
  let width,
    height,
    bits,
    colorType,
    channels,
    interlace,
    palette,
    transparency,
    ended = false,
    idatEnded = false,
    animationFrames = 0,
    frameCount = 0,
    sequence = 0,
    currentFrame,
    firstFrame,
    frameHasData = false
  const metadata = { animated: false },
    seen = new Set(),
    compressed = [],
    frameCompressed = []
  const checkSequence = (value) => {
    if (value !== sequence) invalid('APNG sequence')
    sequence++
  }
  const once = (type) => {
    if (seen.has(type)) invalid('duplicate ' + type)
    seen.add(type)
  }
  const warn = (reason) => {
    const warnings = (metadata.colorWarnings ??= [])
    if (!warnings.includes(reason)) warnings.push(reason)
  }
  for (const { type, data } of pngChunks(input)) {
    if (!seen.has('IHDR') && type !== 'IHDR') invalid('IHDR must be first')
    if (compressed.length && type !== 'IDAT') idatEnded = true
    const view = dataView(data)
    if (COLOR_CHUNKS.has(type)) {
      if (seen.has('PLTE') || compressed.length) invalid(type + ' ordering')
      once(type)
    }
    if (type === 'IHDR') {
      once(type)
      exact(data, 13, type)
      width = view.getUint32(0)
      height = view.getUint32(4)
      bits = data[8]
      colorType = data[9]
      interlace = data[12]
      if (
        !width ||
        !height ||
        width > 0x7fffffff ||
        height > 0x7fffffff ||
        !DEPTHS[colorType]?.includes(bits) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        interlace > 1
      )
        invalid('unsupported IHDR layout')
      channels = CHANNELS[colorType]
      safeSize(width * height * 4)
    } else if (type === 'PLTE') {
      once(type)
      if (
        compressed.length ||
        seen.has('tRNS') ||
        [0, 4].includes(colorType) ||
        !data.length ||
        data.length % 3 ||
        data.length > 768 ||
        (colorType === 3 && data.length / 3 > 2 ** bits)
      )
        invalid('PLTE layout or ordering')
      palette = data
    } else if (type === 'tRNS') {
      once(type)
      if (compressed.length || [4, 6].includes(colorType)) invalid('tRNS layout or ordering')
      if (colorType === 3) {
        if (!palette || !data.length || data.length > palette.length / 3) invalid('tRNS palette length')
        transparency = data
      } else {
        exact(data, colorType === 0 ? 2 : 6, type)
        transparency = Array.from(
          { length: colorType === 0 ? 1 : 3 },
          (_, i) => view.getUint16(i * 2) & (2 ** bits - 1)
        )
      }
    } else if (type === 'IDAT') {
      if (idatEnded || (colorType === 3 && !palette)) invalid('IDAT ordering or missing palette')
      compressed.push(data)
      if (currentFrame?.defaultImage) frameHasData = true
    } else if (type === 'IEND') {
      exact(data, 0, type)
      if (!compressed.length) invalid('missing IDAT')
      ended = true
    } else if (type === 'iCCP') metadata.icc = profileBytes(data)
    else if (type === 'sRGB') {
      exact(data, 1, type)
      if (data[0] > 3) invalid('sRGB intent')
      metadata.srgb = data[0]
    } else if (type === 'gAMA') {
      exact(data, 4, type)
      metadata.gamma = view.getUint32(0) / 100000
      if (!metadata.gamma) warn('png-zero-gamma')
    } else if (type === 'cHRM') {
      exact(data, 32, type)
      metadata.chromaticities = Object.fromEntries(
        ['white', 'red', 'green', 'blue'].map((name, i) => [
          name,
          [view.getUint32(i * 8) / 100000, view.getUint32(i * 8 + 4) / 100000]
        ])
      )
    } else if (type === 'cICP') {
      exact(data, 4, type)
      if (data[2] !== 0 || data[3] > 1) invalid('cICP matrix or range')
      metadata.cicp = {
        colorPrimaries: data[0],
        transferCharacteristics: data[1],
        matrixCoefficients: data[2],
        fullRange: data[3]
      }
    } else if (type === 'sBIT') {
      exact(data, colorType === 3 ? 3 : channels, type)
      if (data.some((value) => value < 1 || value > (colorType === 3 ? 8 : bits)))
        invalid('sBIT sample depth')
      metadata.significantBits = Array.from(data)
    } else if (type === 'eXIf') {
      once(type)
      if (
        compressed.length ||
        data.length < 8 ||
        !(
          (data[0] === 73 && data[1] === 73 && data[2] === 42 && data[3] === 0) ||
          (data[0] === 77 && data[1] === 77 && data[2] === 0 && data[3] === 42)
        )
      )
        invalid('eXIf header or ordering')
      metadata.exif = data.slice()
    } else if (type === 'mDCV' || type === 'cLLI') {
      exact(data, type === 'mDCV' ? 24 : 8, type)
      metadata[type === 'mDCV' ? 'mdcv' : 'clli'] = data.slice()
    } else if (type === 'acTL') {
      once(type)
      exact(data, 8, type)
      if (compressed.length || !view.getUint32(0)) invalid('acTL layout or ordering')
      animationFrames = view.getUint32(0)
      metadata.animated = true
    } else if (type === 'fcTL') {
      exact(data, 26, type)
      if (!metadata.animated || (currentFrame && !frameHasData)) invalid('fcTL ordering')
      checkSequence(view.getUint32(0))
      currentFrame = {
        width: view.getUint32(4),
        height: view.getUint32(8),
        x: view.getUint32(12),
        y: view.getUint32(16),
        blend: data[25],
        defaultImage: !compressed.length
      }
      const frame = currentFrame
      if (
        !frame.width ||
        !frame.height ||
        frame.x + frame.width > width ||
        frame.y + frame.height > height ||
        data[24] > 2 ||
        frame.blend > 1 ||
        (frame.defaultImage && (frame.width !== width || frame.height !== height || frame.x || frame.y))
      )
        invalid('APNG frame rectangle or operation')
      firstFrame ??= frame
      frameCount++
      frameHasData = false
    } else if (type === 'fdAT') {
      if (
        data.length < 4 ||
        !metadata.animated ||
        !compressed.length ||
        !currentFrame ||
        currentFrame.defaultImage
      )
        invalid('fdAT ordering or length')
      checkSequence(view.getUint32(0))
      if (currentFrame === firstFrame) frameCompressed.push(data.subarray(4))
      frameHasData = true
    } else if (!(type.charCodeAt(0) & 32)) throw Error('Unsupported PNG critical chunk: ' + type)
  }
  if (!ended) invalid('missing IEND')
  if (metadata.animated && (!firstFrame || frameCount !== animationFrames || !frameHasData))
    invalid('APNG frame count or data')
  if (metadata.mdcv && !metadata.cicp) invalid('mDCV requires cICP')
  const imageWidth = firstFrame?.width ?? width,
    imageHeight = firstFrame?.height ?? height,
    imageX = firstFrame?.x ?? 0,
    imageY = firstFrame?.y ?? 0,
    imageCompressed = firstFrame && !firstFrame.defaultImage ? frameCompressed : compressed
  if (metadata.animated) metadata.decodedFrame = 'animation-first'
  const passes = (interlace ? ADAM7 : [[0, 0, 1, 1]])
    .map(([x, y, dx, dy]) => {
      const w = Math.max(0, Math.ceil((imageWidth - x) / dx)),
        h = Math.max(0, Math.ceil((imageHeight - y) / dy))
      return { x, y, dx, dy, width: w, height: h, rowBytes: safeSize(Math.ceil((w * channels * bits) / 8)) }
    })
    .filter((pass) => pass.width && pass.height)
  const expected = safeSize(
    passes.reduce((sum, pass) => safeSize(sum + safeSize((pass.rowBytes + 1) * pass.height)), 0)
  )
  const output = new Float32Array(width * height * 4),
    maximum = 2 ** bits - 1,
    bpp = Math.max(1, Math.ceil((channels * bits) / 8))
  let passIndex = 0,
    rowIndex = 0,
    filled = 0,
    count = 0,
    pass,
    scanline,
    previous
  function nextPass() {
    pass = passes[passIndex]
    if (pass) {
      scanline = new Uint8Array(pass.rowBytes + 1)
      previous = new Uint8Array(pass.rowBytes)
    }
    rowIndex = 0
  }
  nextPass()
  function rowReady() {
    const filter = scanline[0],
      row = scanline.subarray(1)
    if (filter > 4) invalid('scanline filter')
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0,
        b = previous[i],
        c = i >= bpp ? previous[i - bpp] : 0
      row[i] =
        (row[i] +
          (filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : filter === 4
                  ? paeth(a, b, c)
                  : 0)) &
        255
    }
    const view = dataView(row),
      sample = (i) =>
        bits === 16
          ? view.getUint16(i * 2)
          : bits === 8
            ? row[i]
            : (row[Math.floor((i * bits) / 8)] >> (8 - bits - ((i * bits) % 8))) & maximum
    for (let x = 0; x < pass.width; x++) {
      const source = x * channels,
        target = ((imageY + pass.y + rowIndex * pass.dy) * width + imageX + pass.x + x * pass.dx) * 4
      if (colorType === 3) {
        const index = sample(source)
        if (index * 3 >= palette.length) {
          output.set([0, 0, 0, 1], target)
          warn('png-palette-index')
          metadata.invalidPaletteIndices = (metadata.invalidPaletteIndices ?? 0) + 1
          continue
        }
        for (let c = 0; c < 3; c++) output[target + c] = palette[index * 3 + c] / 255
        output[target + 3] = (transparency?.[index] ?? 255) / 255
      } else {
        const red = sample(source),
          green = [0, 4].includes(colorType) ? red : sample(source + 1),
          blue = [0, 4].includes(colorType) ? red : sample(source + 2)
        output[target] = red / maximum
        output[target + 1] = green / maximum
        output[target + 2] = blue / maximum
        output[target + 3] = [4, 6].includes(colorType)
          ? sample(source + channels - 1) / maximum
          : transparency &&
              red === transparency[0] &&
              (colorType === 0 || (green === transparency[1] && blue === transparency[2]))
            ? 0
            : 1
      }
      // OVER on the initially transparent animation canvas leaves straight
      // covered colors intact; a zero-coverage result is transparent black.
      if (firstFrame?.blend === 1 && output[target + 3] === 0) output.fill(0, target, target + 3)
    }
    previous.set(row)
    filled = 0
    rowIndex++
    if (rowIndex === pass.height) {
      passIndex++
      nextPass()
    }
  }
  const inflater = new pako.Inflate({ windowBits: 15 })
  inflater.onData = (chunk) => {
    count += chunk.length
    if (count > expected) invalid('inflated samples exceed image extent')
    for (let at = 0; at < chunk.length;) {
      const length = Math.min(chunk.length - at, scanline.length - filled)
      scanline.set(chunk.subarray(at, at + length), filled)
      at += length
      filled += length
      if (filled === scanline.length) rowReady()
    }
  }
  // Suppress pako's default full-image output concatenation; rows are consumed.
  inflater.onEnd = (status) => {
    inflater.err = status
    inflater.msg = inflater.strm.msg
  }
  for (const chunk of imageCompressed) {
    if (!inflater.ended) inflater.push(chunk, false)
    else if (chunk.length) warn('png-idat-trailing-data')
    if (inflater.err) invalid('IDAT compressed stream: ' + inflater.msg)
    if (inflater.ended && inflater.strm.avail_in) warn('png-idat-trailing-data')
  }
  if (!inflater.ended || count !== expected || passIndex !== passes.length || filled)
    invalid('incomplete IDAT samples or zlib trailer')
  return { width, height, data: output, sourceBits: colorType === 3 ? 8 : bits, colorType, metadata }
}
