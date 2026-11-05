import { runImageWorker } from './image-worker.js'
import { analyzeDehaze, createDehazePixel } from './dehaze.js'
import { linearFrameToRgba8 } from './pixel-frame.js'

// The caller relinquishes an owned corrected frame, never a cached original.
// Successful completion returns that frame and its map; after handoff failure
// the caller must recreate the owned copy from its preserved original.
export function analyzeDehazeOwned(frame, { transmission = true, signal } = {}) {
  return runImageWorker(
    new URL('./dehaze-worker.js', import.meta.url),
    { frame, transmission },
    [frame.data.buffer],
    ({ frame, transmission }) => ({ frame, analysis: analyzeDehaze(frame, { transmission }) }),
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
