// SPDX-License-Identifier: AGPL-3.0-only
// Diagnostic fixture only; the builder inserts this into a disposable native host.
;(() => {
  const files = new Map()
  const create = URL.createObjectURL,
    revoke = URL.revokeObjectURL,
    prototype = HTMLMediaElement.prototype,
    src = Object.getOwnPropertyDescriptor(prototype, 'src')
  let assignments = 0,
    injected = false,
    failedPlayer,
    failedFile,
    failedUrl
  function report(stage, detail = {}) {
    globalThis.mygo
      ?.call(
        'Desktop.VideoImportDiagnostic',
        JSON.stringify({ operation: 'controlled-initial-decode', stage, ...detail })
      )
      ?.catch(() => {})
  }
  URL.createObjectURL = function (file) {
    const url = create.call(this, file)
    if (file instanceof File && file.name === 'multitrack.webm' && file.size === 59365) files.set(url, file)
    return url
  }
  URL.revokeObjectURL = function (url) {
    const result = revoke.call(this, url)
    files.delete(url)
    if (url === failedUrl) {
      report('failed-player-released', {
        sourceRemoved: !failedPlayer.hasAttribute('src'),
        readyState: failedPlayer.readyState
      })
      failedPlayer = failedUrl = undefined
    }
    return result
  }
  Object.defineProperty(prototype, 'src', {
    ...src,
    set(url) {
      const file = files.get(url)
      if (file) {
        const assignment = ++assignments
        if (assignment <= 4)
          report('source-assigned', {
            assignment,
            sameOriginal: assignment === 3 ? file === failedFile : undefined
          })
        if (assignment === 3) failedFile = undefined
        if (assignment === 2) {
          this.addEventListener(
            'loadedmetadata',
            (event) => {
              if (injected || !event.isTrusted || !this.videoWidth || !this.videoHeight) return
              injected = true
              failedPlayer = this
              failedFile = file
              failedUrl = url
              Object.defineProperty(this, 'error', {
                value: { code: 3, message: 'Controlled initial native decode failure' }
              })
              report('injected', {
                trusted: event.isTrusted,
                width: this.videoWidth,
                height: this.videoHeight,
                readyState: this.readyState,
                mediaErrorCode: this.error.code,
                assignment
              })
              this.dispatchEvent(new Event('error'))
            },
            { once: true }
          )
        } else if (assignment === 3) {
          // Observe before the awaited listener resumes preparation and starts a seek.
          this.addEventListener(
            'loadeddata',
            (event) =>
              report('recovery-loadeddata', {
                trusted: event.isTrusted,
                width: this.videoWidth,
                height: this.videoHeight,
                readyState: this.readyState
              }),
            { once: true, capture: true }
          )
        }
      }
      src.set.call(this, url)
    }
  })
})()
