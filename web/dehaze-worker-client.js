import { runImageWorker } from './image-worker.js'
import { analyzeDehaze } from './dehaze.js'

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
