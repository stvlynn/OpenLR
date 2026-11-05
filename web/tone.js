// Shared global tone rules. RGB is linear-light; alpha never enters this rule.
export function globalToneParameters(edit = {}, { legacy = false } = {}) {
  const value = (name) => (edit[name] || 0) / 100
  const gain = 2 ** (edit.Exposure || 0),
    warmth = value('Temperature'),
    tint = value('Tint')
  return {
    redGain: gain * 2 ** warmth,
    greenGain: gain * 2 ** (-tint / 2),
    blueGain: gain * 2 ** -warmth,
    slope: 2 ** value('Contrast'),
    shadows: value('Shadows'),
    lights: value('Highlights'),
    white: value('Whites'),
    black: value('Blacks'),
    sat: value('Saturation'),
    vib: value('Vibrance'),
    legacy
  }
}

// Destination is optional so both byte adapters and float loops can avoid a
// per-pixel allocation. The function has no state and never clips RGB.
export function globalToneRgb(red, green, blue, parameters, output = [], offset = 0) {
  const { redGain, greenGain, blueGain, slope, shadows, lights, white, black, sat, vib, legacy } = parameters
  const r = red * redGain,
    g = green * greenGain,
    b = blue * blueGain
  if (!shadows && !lights && !white && !black && !sat && !vib) {
    output[offset] = (r - 0.18) * slope + 0.18
    output[offset + 1] = (g - 0.18) * slope + 0.18
    output[offset + 2] = (b - 0.18) * slope + 0.18
    return output
  }
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b,
    // Only the SDR tonal influence is bounded. Signed and HDR RGB survive.
    y = legacy ? Math.min(1, lum) : Math.max(0, Math.min(1, lum))
  const shift =
    shadows * y * (1 - y) ** 3 * 2 +
    lights * y ** 3 * (1 - y) * 2 +
    white * y ** 4 * 0.35 +
    black * (1 - y) ** 4 * 0.12
  const chroma = Math.max(r, g, b) - Math.min(r, g, b)
  const saturation = Math.max(0, 1 + sat + vib * (1 - Math.min(1, chroma)))
  const tone = (lum + shift - 0.18) * slope + 0.18
  output[offset] = tone + (r - lum) * saturation * slope
  output[offset + 1] = tone + (g - lum) * saturation * slope
  output[offset + 2] = tone + (b - lum) * saturation * slope
  return output
}

export function createGlobalTone(edit = {}) {
  const parameters = globalToneParameters(edit)
  const { redGain, greenGain, blueGain, slope, shadows, lights, white, black, sat, vib } = parameters
  if (
    redGain === 1 &&
    greenGain === 1 &&
    blueGain === 1 &&
    slope === 1 &&
    !shadows &&
    !lights &&
    !white &&
    !black &&
    !sat &&
    !vib
  )
    return null
  return (data, offset) =>
    globalToneRgb(data[offset], data[offset + 1], data[offset + 2], parameters, data, offset)
}
