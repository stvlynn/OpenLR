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

export function beginVideoExportTrace(format) {
  if (!globalThis.openlrDiagnostics) return
  const sequence = ++nextSequence
  const started = performance.now()
  return (stage, index) =>
    send({
      operation: 'export',
      sequence,
      format: format === 'video/mp4' ? 'mp4' : 'webm',
      stage,
      elapsedMs: Math.round(performance.now() - started),
      ...(Number.isSafeInteger(index) && { index })
    })
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

export function beginNativeVideoPlaybackTrace(request) {
  if (!globalThis.openlrDiagnostics || !['video-seek', 'video-pause'].includes(request.command)) return
  const requestedTime = request.args?.time
  const trace = {
    [videoSeekTrace]: true,
    operation: request.command === 'video-pause' ? 'pause' : 'seek',
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
      operation: trace.operation,
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
      width: video?.videoWidth,
      height: video?.videoHeight,
      duration: video ? (Number.isFinite(video.duration) ? video.duration : null) : undefined,
      mediaErrorCode: video ? (video.error?.code ?? null) : undefined,
      event
    })
  } catch {
    // A diagnostic sample must not affect playback.
  }
}

export function observeVideoSeek(trace, video, seekTime) {
  return observePlaybackEvents(trace, video, ['seeking', 'seeked', 'error'], 'seek-event', seekTime)
}

export function observeVideoPlaybackLoad(trace, video) {
  return observePlaybackEvents(trace, video, mediaEvents, 'playback-load-event')
}

function observePlaybackEvents(trace, video, names, stage, seekTime) {
  if (!trace) return
  const events = new AbortController()
  for (const event of names)
    video.addEventListener(event, () => markVideoSeek(trace, stage, video, { event, seekTime }), {
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
