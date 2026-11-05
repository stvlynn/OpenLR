// A short-lived worker owns each codec heap. The queue bounds concurrent memory use.
let queue = Promise.resolve()
const diagnostics = []
export const getImageWorkerDiagnostics = () => diagnostics.map((item) => ({ ...item }))
export function runImageWorker(url, message, transfers = [], fallback, { signal } = {}) {
  let canceled = false,
    cancelActive = null,
    rejectAbort
  const abortError = () =>
    Object.assign(new Error('Image processing canceled'), { name: 'AbortError', code: 'ABORTED' })
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject
  })
  const cancel = () => {
    if (canceled) return
    canceled = true
    const error = abortError()
    cancelActive?.(error)
    message = null
    transfers = []
    fallback = null
    rejectAbort(error)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()

  const task = queue.then(() => {
    if (canceled) return
    return new Promise((resolve, reject) => {
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
        cancelActive = null
        clearTimeout(timer)
        worker?.terminate()
        message = null
        transfers = []
        fallback = null
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
        cancelActive = null
        clearTimeout(timer)
        worker?.terminate()
        const runFallback = fallback,
          payload = message
        message = null
        transfers = []
        fallback = null
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
          .then(() => (canceled ? undefined : runFallback(payload)))
          .then((result) => {
            if (canceled) {
              result?.bitmap?.close()
              reject(abortError())
            } else resolve(result)
          }, reject)
      }
      cancelActive = (error) => finish(error)
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
            if (ready) return
            ready = true
            try {
              worker.postMessage(message, transfers)
              message = null
              transfers = []
              fallback = null
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
  })
  queue = task.then(
    () => {},
    () => {}
  )
  return Promise.race([task, aborted]).finally(() => signal?.removeEventListener('abort', cancel))
}
