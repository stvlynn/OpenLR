import { decodeRaw } from './raw-kernel.js'
self.onmessage = async ({ data: { file, linear = false } }) => {
  let bitmap
  try {
    const result = await decodeRaw(file, { linear })
    if (linear) self.postMessage({ frame: result }, [result.linear.buffer, result.data.buffer])
    else {
      bitmap = result
      self.postMessage({ bitmap }, [bitmap])
      bitmap = null
    }
  } catch (error) {
    self.postMessage({ code: error.code || 'RAW_DECODE', message: error.message })
  } finally {
    bitmap?.close()
  }
}
self.postMessage({ ready: true })
