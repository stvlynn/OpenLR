import { renderCorrectedFrame } from './frame-render.js'

self.onmessage = ({ data: { frame, analysis, edit, maxSize, reference } }) => {
  try {
    const result = renderCorrectedFrame(frame, edit, maxSize, reference, analysis)
    self.postMessage({ frame: result }, [result.data.buffer])
  } catch (error) {
    self.postMessage({ code: error.code || 'DEHAZE_FRAME', message: error.message })
  }
}
self.postMessage({ ready: true })
