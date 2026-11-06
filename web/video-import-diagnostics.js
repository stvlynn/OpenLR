const importErrorNames = new Set([
  'SecurityError',
  'InvalidStateError',
  'NotSupportedError',
  'NotAllowedError',
  'AbortError',
  'DataError',
  'QuotaExceededError',
  'UnknownError',
  'TypeError',
  'Error'
])
const mediaEvents = ['loadstart', 'loadedmetadata', 'loadeddata', 'stalled', 'suspend', 'error']
let nextSequence = 0
const videoSeekTrace = Symbol()

function send(report) {
  try {
    // A stalled or failed diagnostic bridge cannot hold up a video command.
    globalThis.mygo?.call?.('Desktop.VideoImportDiagnostic', JSON.stringify(report))?.catch(() => {})
  } catch {
    // The command owns its result and any error.
  }
}

function emit(trace, extra) {
  send({
    sequence: trace.sequence,
    stage: trace.stage,
    elapsedMs: Math.round(performance.now() - trace.started),
    declaredVideoType: trace.declaredVideoType,
    blobOrigin: trace.blobOrigin,
    readyState: trace.readyState,
    networkState: trace.networkState,
    width: trace.width,
    height: trace.height,
    mediaErrorCode: trace.mediaErrorCode,
    ...extra
  })
}

export function beginNativeVideoImportTrace(request) {
  const files = request.args?.files
  if (
    !globalThis.openlrDiagnostics ||
    request.command !== 'import' ||
    !Array.isArray(files) ||
    !files.some((file) => typeof file?.type === 'string' && file.type.startsWith('video/'))
  )
    return
  const started = performance.now()
  markNativeVideoImport(started, 'renderer-received')
  return started
}

export function markNativeVideoImport(started, stage) {
  if (started !== undefined) send({ stage, elapsedMs: Math.round(performance.now() - started) })
}

export function beginNativeVideoSeekTrace(request) {
  if (!globalThis.openlrDiagnostics || request.command !== 'video-seek') return
  const requestedTime = request.args?.time
  const trace = {
    [videoSeekTrace]: true,
    sequence: ++nextSequence,
    started: performance.now(),
    requestedTime: Number.isFinite(requestedTime) ? requestedTime : null
  }
  markVideoSeek(trace, 'renderer-received')
  return trace
}

export function markVideoSeek(trace, stage, video, { event, seekTime } = {}) {
  if (!trace?.[videoSeekTrace]) return
  try {
    const currentTime = video?.currentTime
    send({
      operation: 'seek',
      sequence: trace.sequence,
      stage,
      elapsedMs: Math.round(performance.now() - trace.started),
      requestedTime: trace.requestedTime,
      seekTime,
      currentTime: video ? (Number.isFinite(currentTime) ? currentTime : null) : undefined,
      seeking: video?.seeking,
      seekableRanges: video?.seekable.length,
      readyState: video?.readyState,
      networkState: video?.networkState,
      mediaErrorCode: video ? (video.error?.code ?? null) : undefined,
      event
    })
  } catch {
    // A diagnostic sample must not affect playback.
  }
}

export function observeVideoSeek(trace, video, seekTime) {
  if (!trace) return
  const events = new AbortController()
  for (const event of ['seeking', 'seeked', 'error'])
    video.addEventListener(event, () => markVideoSeek(trace, 'seek-event', video, { event, seekTime }), {
      once: true,
      signal: events.signal
    })
  return () => events.abort()
}

export function beginVideoImportTrace(file) {
  if (!globalThis.openlrDiagnostics) return
  const trace = {
    sequence: ++nextSequence,
    started: performance.now(),
    declaredVideoType: file.type.startsWith('video/')
  }
  markVideoImport(trace, 'input')
  return trace
}

export function markVideoImport(trace, stage, video) {
  if (!trace) return
  trace.stage = stage
  if (video) recordVideoImportState(trace, video)
  emit(trace)
}

export function recordVideoImportState(trace, video) {
  if (!trace) return
  trace.readyState = video.readyState
  trace.networkState = video.networkState
  trace.width = video.videoWidth
  trace.height = video.videoHeight
  trace.mediaErrorCode = video.error?.code ?? null
}

export function observeVideoImportMedia(trace, video, url) {
  if (!trace) return
  const origin = new URL(url).origin
  trace.blobOrigin = origin === 'null' ? 'opaque' : origin === location.origin ? 'same' : 'different'
  const events = new AbortController()
  for (const event of mediaEvents)
    video.addEventListener(
      event,
      () => {
        recordVideoImportState(trace, video)
        emit(trace, { event })
      },
      { once: true, signal: events.signal }
    )
  return () => events.abort()
}

export function reportVideoImportFailure(trace, error) {
  if (!trace) return
  emit(trace, {
    errorName: importErrorNames.has(error?.name) ? error.name : 'other',
    secureContext: isSecureContext,
    documentOrigin: location.origin === 'null' ? 'opaque' : 'tuple',
    nativeScheme: location.protocol === 'mygo:',
    videoDecoder: typeof VideoDecoder === 'function',
    videoEncoder: typeof VideoEncoder === 'function',
    audioDecoder: typeof AudioDecoder === 'function',
    audioEncoder: typeof AudioEncoder === 'function'
  })
}
