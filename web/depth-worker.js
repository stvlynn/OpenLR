import { inferDepth } from './depth-kernel.js'
postMessage({ ready: true })
onmessage = async ({ data }) => {
  try {
    const result = await inferDepth({ ...data, onProgress: (progress) => postMessage({ progress }) })
    postMessage(result, [result.mask.buffer])
  } catch (error) {
    postMessage({ code: 'DEPTH', message: 'Depth estimation failed: ' + error.message })
  }
}
