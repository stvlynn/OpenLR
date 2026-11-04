import { mergeHDR, mergePanorama } from './merge-core.js'
import { openCV } from './cv-runtime.js'
export async function processMerge({ kind, frames, options }) {
  const cv = await openCV()
  return { result: kind === 'hdr' ? mergeHDR(cv, frames, options) : mergePanorama(cv, frames, options) }
}
