import { runImageWorker } from './image-worker.js'
import { createDehazePixel } from './dehaze.js'
import { prepareDehazeAnalysis } from './dehaze-analysis.js'
import { linearFrameToRgba8 } from './pixel-frame.js'
import { renderCorrectedFrame } from './frame-render.js'

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
  return renderSnapshot(
    new URL('./dehaze-encode-worker.js', import.meta.url),
    { frame, analysis, amount },
    ({ frame, analysis, amount }) => ({
      pixels: linearFrameToRgba8(frame, createDehazePixel(amount, analysis))
    }),
    signal
  )
}

export function renderDehazeFrame(frame, analysis, edit, maxSize, reference, { signal } = {}) {
  return renderSnapshot(
    new URL('./dehaze-frame-worker.js', import.meta.url),
    { frame, analysis, edit, maxSize, reference: { width: reference.width, height: reference.height } },
    ({ frame, analysis, edit, maxSize, reference }) => ({
      frame: renderCorrectedFrame(frame, edit, maxSize, reference, analysis)
    }),
    signal
  )
}

function renderSnapshot(url, input, fallback, signal) {
  return runImageWorker(url, input, [], fallback, {
    signal,
    prepareMessage: ({ frame, analysis, ...parameters }) => {
      const owned = { ...frame, data: frame.data.slice() }
      const estimate = { ...analysis, transmission: analysis.transmission?.slice() ?? null }
      const transfers = [owned.data.buffer]
      if (estimate.transmission) transfers.push(estimate.transmission.buffer)
      return { message: { ...parameters, frame: owned, analysis: estimate }, transfers }
    }
  })
}
