import { analyzeDehaze } from './dehaze.js'

self.onmessage = ({ data: { frame, transmission } }) => {
  try {
    const analysis = analyzeDehaze(frame, { transmission })
    const transfers = [frame.data.buffer]
    if (analysis.transmission) transfers.push(analysis.transmission.buffer)
    self.postMessage({ frame, analysis }, transfers)
  } catch (error) {
    self.postMessage({ code: error.code || 'DEHAZE_ANALYSIS', message: error.message })
  }
}
self.postMessage({ ready: true })
