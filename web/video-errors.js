const phases = new Set([
  'initial-load',
  'poster-presentation',
  'initial-finalize',
  'seek',
  'frame-access',
  'frame-decode',
  'frame-read',
  'initial-open',
  'initial-position',
  'initial-frame',
  'source-metadata',
  'requested-seek',
  'requested-trim',
  'play-start',
  'pause-frame',
  'draw-frame',
  'draw-paint',
  'refresh-frame',
  'refresh-paint'
])
const origins = new Set(['native-media', 'native-pixels', 'frame-decoder', 'unknown'])
const errorConstructors = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'NativeMediaError',
  'DOMException'
])
const errorNames = new Set([
  ...errorConstructors,
  'AbortError',
  'DataError',
  'EncodingError',
  'InvalidStateError',
  'NotSupportedError',
  'NotAllowedError',
  'SecurityError',
  'OperationError',
  'QuotaExceededError',
  'UnknownError',
  'NetworkError',
  'TimeoutError'
])
const loads = new WeakMap()
const errorLoads = new WeakMap()

export function videoErrorContext(video, load) {
  loads.set(video, load)
  return (error, phase, origin) => annotateVideoError(error, { phase, origin, video })
}

// Only this bounded description crosses the existing error.details boundary.
export function videoFailureDetails(value, history = true) {
  if (!value || typeof value !== 'object') return
  const result = {}
  for (const key of ['phase', 'operation']) if (phases.has(value[key])) result[key] = value[key]
  if (origins.has(value.origin)) result.origin = value.origin
  if (errorNames.has(value.errorName)) result.errorName = value.errorName
  if (errorConstructors.has(value.errorConstructor)) result.errorConstructor = value.errorConstructor
  for (const [key, limit] of [
    ['mediaErrorCode', 4],
    ['readyState', 4],
    ['networkState', 3],
    ['attempt', 2],
    ['retriesUsed', 1],
    ['retryLimit', 1],
    ['domExceptionCode', 25]
  ]) {
    if (value[key] === null || (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= limit))
      result[key] = value[key]
  }
  if (value.metadata && typeof value.metadata === 'object') {
    const metadata = {}
    for (const key of ['seen', 'trusted', 'admitted'])
      if (typeof value.metadata[key] === 'boolean' || value.metadata[key] === null)
        metadata[key] = value.metadata[key]
    for (const key of ['width', 'height', 'readyState'])
      if (value.metadata[key] === null || (Number.isFinite(value.metadata[key]) && value.metadata[key] >= 0))
        metadata[key] = value.metadata[key]
    result.metadata = metadata
  }
  if (history && Array.isArray(value.failedLoads))
    result.failedLoads = value.failedLoads
      .slice(0, 2)
      .map((entry) => videoFailureDetails(entry, false))
      .filter(Boolean)
  return Object.keys(result).length ? result : undefined
}

export function annotateVideoError(error, { phase, operation, origin, video, load } = {}) {
  try {
    if (error.details != null && (typeof error.details !== 'object' || Array.isArray(error.details)))
      return error
    if (
      error.details?.video != null &&
      (typeof error.details.video !== 'object' || Array.isArray(error.details.video))
    )
      return error
    load ??= loads.get(video)
    const owner = errorLoads.get(error)
    const ownsLoad = !owner || owner === load
    const previous = videoFailureDetails(error.details?.video) ?? {}
    const description = { ...previous }
    if (!description.errorName && errorNames.has(error.name)) description.errorName = error.name
    if (!description.errorConstructor) {
      if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
        description.errorConstructor = 'DOMException'
        description.domExceptionCode = error.code
      } else if (error instanceof Error && errorConstructors.has(error.constructor?.name))
        description.errorConstructor = error.constructor.name
    }
    if (!description.phase && (phase || operation)) description.phase = phase || operation
    if (!description.operation && operation) description.operation = operation
    if (ownsLoad && (!description.origin || description.origin === 'unknown'))
      description.origin = origin ?? 'unknown'
    if (!Object.hasOwn(description, 'mediaErrorCode')) description.mediaErrorCode = video?.error?.code ?? null
    if (!Object.hasOwn(description, 'readyState')) description.readyState = video?.readyState ?? null
    if (!Object.hasOwn(description, 'networkState')) description.networkState = video?.networkState ?? null
    if (load && ownsLoad)
      Object.assign(description, {
        attempt: load.attempt,
        retriesUsed: load.attempt - 1,
        retryLimit: load.retryLimit,
        metadata: { ...load.metadata },
        failedLoads: load.failedLoads
      })
    error.details = {
      ...error.details,
      video: { ...error.details?.video, ...videoFailureDetails(description) }
    }
    if (load && ownsLoad) errorLoads.set(error, load)
  } catch {
    // Diagnostic annotation must preserve even a non-extensible original failure.
  }
  return error
}
