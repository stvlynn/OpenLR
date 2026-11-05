import { processCodec } from './codec-kernel.js'
self.onmessage = async ({ data }) => {
  let result
  try {
    result = await processCodec(data)
    self.postMessage(result, [result.frame?.data.buffer || result.bitmap || result.bytes])
    result = null
  } catch (error) {
    self.postMessage({ code: error.code || 'CODEC_ERROR', message: error.message })
  } finally {
    result?.bitmap?.close()
  }
}
self.postMessage({ ready: true })
