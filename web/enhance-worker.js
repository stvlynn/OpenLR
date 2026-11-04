import { processEnhance } from './enhance-kernel.js'
postMessage({ ready: true })
onmessage = async ({ data }) => {
  try {
    const result = await processEnhance({ ...data, onProgress: (progress) => postMessage({ progress }) })
    postMessage(result, [result.data.buffer])
  } catch (error) {
    postMessage({ code: 'ENHANCE', message: 'Neural enhancement failed: ' + error.message })
  }
}
