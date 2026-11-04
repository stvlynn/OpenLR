import { inferSemantic } from './ai-kernel.js'
self.onmessage = async ({ data }) => {
  try {
    const result = await inferSemantic(data)
    self.postMessage(result, [result.mask.buffer])
  } catch (error) {
    self.postMessage({ code: 'AI_INFERENCE', message: 'Semantic segmentation failed: ' + error.message })
  }
}
self.postMessage({ ready: true })
