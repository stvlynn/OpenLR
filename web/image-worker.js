// A short-lived worker owns each codec heap. The queue bounds concurrent memory use.
let queue = Promise.resolve()
const diagnostics = []
export const getImageWorkerDiagnostics = () => diagnostics.map((item) => ({ ...item }))
export function runImageWorker(url, message, transfers = [], fallback) {
  const task = queue.then(
    () =>
      new Promise((resolve, reject) => {
        let worker,
          timer,
          finished = false,
          ready = false
        function finish(error, result) {
          if (finished) {
            result?.bitmap?.close()
            return
          }
          finished = true
          clearTimeout(timer)
          worker?.terminate()
          if (error) reject(error)
          else resolve(result)
        }
        function startFailed(error) {
          if (ready || !fallback) {
            finish(error)
            return
          }
          if (finished) return
          finished = true
          clearTimeout(timer)
          worker?.terminate()
          const diagnostic = {
            worker: url.pathname.split('/').pop(),
            phase: 'startup',
            fallback: 'main-thread',
            message: error.message
          }
          diagnostics.push(diagnostic)
          if (diagnostics.length > 20) diagnostics.shift()
          console.warn('OpenLR image Worker startup failed; using the shared codec kernel', diagnostic)
          Promise.resolve()
            .then(() => fallback(message))
            .then(resolve, reject)
        }
        try {
          worker = new Worker(url, { type: 'module' })
          const timeout = () =>
            finish(
              Object.assign(new Error('Image processing made no progress for two minutes'), {
                code: 'TIMEOUT'
              })
            )
          timer = setTimeout(timeout, 120000)
          worker.onmessage = ({ data }) => {
            if (finished) {
              data.bitmap?.close()
              return
            }
            if (data.ready) {
              ready = true
              try {
                worker.postMessage(message, transfers)
              } catch (error) {
                finish(error)
              }
              return
            }
            if (!ready) {
              startFailed(new Error('Image Worker did not complete its startup handshake'))
              return
            }
            if (data.progress) {
              clearTimeout(timer)
              timer = setTimeout(timeout, 120000)
              return
            }
            data.code
              ? finish(Object.assign(new Error(data.message || 'Image codec failed'), { code: data.code }))
              : finish(null, data)
          }
          worker.onerror = (event) => {
            event.preventDefault()
            startFailed(
              Object.assign(new Error(event.message || 'Image codec could not start or ran out of memory'), {
                code: 'WORKER'
              })
            )
          }
          worker.onmessageerror = () => finish(new Error('Cannot transfer the image codec result'))
          // Wait for ready before transferring buffers so startup fallback retains ownership.
        } catch (error) {
          startFailed(error)
        }
      })
  )
  queue = task.then(
    () => {},
    () => {}
  )
  return task
}
