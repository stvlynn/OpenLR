import { prepareDehazeAnalysis } from './dehaze-analysis.js'

self.onmessage = ({ data: { frame: input, transmission, encoding } }) => {
  try {
    const { frame, analysis } = prepareDehazeAnalysis(input, { transmission, encoding })
    const transfers = [frame.data.buffer]
    if (analysis.transmission) transfers.push(analysis.transmission.buffer)
    self.postMessage({ frame, analysis }, transfers)
  } catch (error) {
    self.postMessage({ code: error.code || 'DEHAZE_ANALYSIS', message: error.message })
  }
}
self.postMessage({ ready: true })
