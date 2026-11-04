import { evaluatePhoto } from './culling-kernel.js'
self.postMessage({ ready: true })
self.onmessage = async ({ data }) => {
  try {
    self.postMessage(await evaluatePhoto(data))
  } catch (error) {
    self.postMessage({ code: 'CULLING', message: error.message || String(error) })
  }
}
