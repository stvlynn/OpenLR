import { analyzeDehaze } from './dehaze.js'
import { rgba8ToLinearFrame } from './pixel-frame.js'

// Shared worker/startup-fallback boundary: byte inputs are decoded before the
// existing source-resolution analyzer, and only linear snapshots are published.
export function prepareDehazeAnalysis(input, { encoding = 'linear', transmission = true } = {}) {
  if (!['linear', 'rgba8'].includes(encoding)) throw new TypeError('Unknown dehaze input encoding')
  const frame = encoding === 'rgba8' ? rgba8ToLinearFrame(input) : input
  return { frame, analysis: analyzeDehaze(frame, { transmission }) }
}
