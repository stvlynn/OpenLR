import { createProfileToLinearSrgb } from './icc-input.js'
import { createNamedInputTransform } from './color-spaces.js'
import { assertLinearFrame } from './pixel-frame.js'

// The decoder owns these normalized encoded samples. Transform in place so
// high-depth input does not require an extra full-size float scratch image.
export function convertInputPixels(
  pixels,
  { profile, sourceSpace = 'srgb', transform: suppliedTransform, provenance = {} } = {}
) {
  const transform =
    suppliedTransform ??
    (profile?.length ? createProfileToLinearSrgb(profile) : createNamedInputTransform(sourceSpace))
  if (transform.reason) return { reason: transform.reason }
  const { width, height, data } = pixels
  if (
    !Number.isSafeInteger(width) ||
    width < 1 ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    !Number.isSafeInteger(width * height * 4) ||
    !(data instanceof Float32Array) ||
    data.length !== width * height * 4
  )
    throw Error('Invalid normalized input frame')
  for (let i = 0; i < data.length; i += 4) {
    if (
      ![data[i], data[i + 1], data[i + 2], data[i + 3]].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
    )
      throw Error('Invalid normalized input sample')
    transform.convert(data[i], data[i + 1], data[i + 2], data, i)
  }
  return {
    frame: assertLinearFrame({
      width,
      height,
      data,
      colorSpace: 'srgb-linear',
      provenance: { colorTransform: profile?.length ? 'icc-matrix-trc' : sourceSpace, ...provenance }
    })
  }
}

export const INPUT_PRECISION_MESSAGES = {
  label: 'Decoded precision',
  compatibility: '8-bit compatibility decode',
  damagedPixels: 'Some pixels could not be recovered.'
}

export function inputPrecisionDescription(provenance) {
  if (!provenance) return ''
  const bits = provenance.sourceBits ?? provenance.outputBits,
    precision =
      provenance.precision === 'rgba8-display'
        ? INPUT_PRECISION_MESSAGES.compatibility
        : bits
          ? `${bits}-bit`
          : '',
    description = precision ? `${INPUT_PRECISION_MESSAGES.label}: ${precision}` : ''
  return provenance.colorWarnings?.includes('png-palette-index')
    ? [description, INPUT_PRECISION_MESSAGES.damagedPixels].filter(Boolean).join('\n')
    : description
}
