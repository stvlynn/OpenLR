import { runImageWorker } from './image-worker.js'
import { createDehazePixel } from './dehaze.js'
import { prepareDehazeAnalysis } from './dehaze-analysis.js'
import { linearFrameToRgba8 } from './pixel-frame.js'

// The caller relinquishes owned corrected linear samples or RGBA8 bytes, never
// a cached original. Completion returns a linear frame and its map; after failure
// the caller must recreate the owned copy from its preserved original.
export function analyzeDehazeOwned(frame, { transmission = true, encoding = 'linear', signal } = {}) {
  return runImageWorker(
    new URL('./dehaze-worker.js', import.meta.url),
    { frame, transmission, encoding },
    [frame.data.buffer],
    ({ frame, transmission, encoding }) => prepareDehazeAnalysis(frame, { transmission, encoding }),
    { signal }
  )
}

// Published cache snapshots can have simultaneous preview/export consumers.
// Copy only when admitted; neither transfer nor cancellation can detach them.
export function encodeDehaze(frame, analysis, amount, { signal } = {}) {
  return runImageWorker(
    new URL('./dehaze-encode-worker.js', import.meta.url),
    { frame, analysis, amount },
    [],
    ({ frame, analysis, amount }) => ({
      pixels: linearFrameToRgba8(frame, createDehazePixel(amount, analysis))
    }),
    {
      signal,
      prepareMessage: ({ frame, analysis, amount }) => {
        const owned = { ...frame, data: frame.data.slice() }
        const estimate = { ...analysis, transmission: analysis.transmission?.slice() ?? null }
        const transfers = [owned.data.buffer]
        if (estimate.transmission) transfers.push(estimate.transmission.buffer)
        return { message: { frame: owned, analysis: estimate, amount }, transfers }
      }
    }
  )
}
