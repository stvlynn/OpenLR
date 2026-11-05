import { createDehazePixel } from './dehaze.js'
import { linearFrameToRgba8 } from './pixel-frame.js'

self.onmessage = ({ data: { frame, analysis, amount } }) => {
  try {
    const pixels = linearFrameToRgba8(frame, createDehazePixel(amount, analysis))
    self.postMessage({ pixels }, [pixels.data.buffer])
  } catch (error) {
    self.postMessage({ code: error.code || 'DEHAZE_ENCODING', message: error.message })
  }
}
self.postMessage({ ready: true })
