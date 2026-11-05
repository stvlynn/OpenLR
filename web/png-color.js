// PNG 3 color characterization and precedence, separate from byte reconstruction.
// Primary evidence, assumptions and independent checks: research/png-input-color.md.
import { createChromaticInputTransform } from './color-spaces.js'
import { convertInputPixels } from './input-color.js'
import { createGrayProfileToLinearSrgb } from './icc-input.js'

function pngProfile(profile, colorType) {
  if (!(profile instanceof Uint8Array) || profile.length < 20) throw Error('Invalid PNG ICC profile')
  const space = String.fromCharCode(...profile.subarray(16, 20)),
    gray = [0, 4].includes(colorType)
  if (space === 'GRAY') {
    if (!gray) throw Error('PNG ICC profile does not match image color type')
    return { transform: createGrayProfileToLinearSrgb(profile) }
  }
  if (space !== 'RGB ' || gray) throw Error('PNG ICC profile does not match image color type')
  return null
}

/** Interpret the highest declared PNG characterization; valid unsupported
 * characterization returns a reason for the explicit display compatibility
 * adapter, never a silent lower-priority relabeling. Alpha is never transformed.
 */
export function convertPngPixels(pixels) {
  const { metadata = {}, sourceBits, colorType } = pixels,
    provenance = {
      decoder: 'png',
      sourceBits,
      precision: sourceBits > 8 ? 'uint16-source' : 'integer-source',
      ...(metadata.significantBits ? { significantBits: [...metadata.significantBits] } : {}),
      ...(metadata.animated ? { animated: true } : {}),
      ...(metadata.decodedFrame ? { decodedFrame: metadata.decodedFrame } : {}),
      ...(metadata.invalidPaletteIndices ? { invalidPaletteIndices: metadata.invalidPaletteIndices } : {}),
      ...(metadata.colorWarnings?.length ? { colorWarnings: [...metadata.colorWarnings] } : {})
    }
  let options
  if (metadata.cicp) {
    const { colorPrimaries, transferCharacteristics, matrixCoefficients, fullRange } = metadata.cicp
    if (matrixCoefficients !== 0 || ![0, 1].includes(fullRange)) throw Error('Invalid PNG cICP layout')
    if (fullRange !== 1 || transferCharacteristics !== 13 || ![1, 12].includes(colorPrimaries))
      return {
        reason: 'png-cicp',
        provenance: { ...provenance, pngColorSource: 'cicp', colorPrimaries, transferCharacteristics }
      }
    options = { sourceSpace: colorPrimaries === 12 ? 'display-p3' : 'srgb' }
    provenance.pngColorSource = 'cicp'
    provenance.colorPrimaries = colorPrimaries
    provenance.transferCharacteristics = transferCharacteristics
  } else if (metadata.icc) {
    const gray = pngProfile(metadata.icc, colorType)
    options = gray ?? { profile: metadata.icc }
    if (gray?.transform.kind === 'gray-trc') provenance.colorTransform = 'icc-gray-trc'
    provenance.pngColorSource = 'iccp'
  } else if (metadata.srgb !== undefined) {
    if (![0, 1, 2, 3].includes(metadata.srgb)) throw Error('Invalid PNG sRGB rendering intent')
    options = { sourceSpace: 'srgb' }
    provenance.pngColorSource = 'srgb'
    provenance.renderingIntent = metadata.srgb
  } else {
    const gamma = metadata.gamma === 0 ? undefined : metadata.gamma,
      chromaticities = metadata.chromaticities,
      assumptions = []
    if (gamma !== undefined && (!Number.isFinite(gamma) || gamma <= 0)) throw Error('Invalid PNG gamma')
    if (gamma !== undefined || chromaticities) {
      options = {
        transform: createChromaticInputTransform({
          chromaticities,
          gamma: gamma === undefined ? undefined : 1 / gamma
        })
      }
      provenance.colorTransform = 'png-gamma-chrm'
      provenance.pngColorSource = gamma !== undefined ? (chromaticities ? 'gamma-chrm' : 'gamma') : 'chrm'
      if (!chromaticities) assumptions.push('srgb-primaries')
      if (gamma === undefined) assumptions.push('srgb-transfer')
    } else {
      options = { sourceSpace: 'srgb' }
      provenance.pngColorSource = 'assumed-srgb'
      assumptions.push('srgb')
    }
    if (assumptions.length) provenance.colorAssumptions = assumptions
    if (metadata.gamma === 0) provenance.colorWarnings = ['png-zero-gamma']
  }
  if (metadata.colorWarnings?.length)
    provenance.colorWarnings = [...new Set([...(provenance.colorWarnings ?? []), ...metadata.colorWarnings])]
  const result = convertInputPixels(pixels, { ...options, provenance })
  return result.reason ? { ...result, provenance } : result
}
