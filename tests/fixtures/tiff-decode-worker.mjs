import { parentPort, workerData } from 'node:worker_threads'
import UTIF from '../../web/vendor/codecs/utif.js'
try {
  const image = UTIF.decode(workerData)[0]
  UTIF.decodeImage(workerData, image)
  parentPort.postMessage({ error: null })
} catch (error) {
  parentPort.postMessage({ error: error.message })
}
