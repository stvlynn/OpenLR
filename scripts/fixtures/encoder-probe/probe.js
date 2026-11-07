// SPDX-License-Identifier: AGPL-3.0-only
export const encoderCases = Object.freeze({
  'quality-default': {},
  'quality-software': { latencyMode: 'quality', hardwareAcceleration: 'prefer-software' },
  'realtime-software': { latencyMode: 'realtime', hardwareAcceleration: 'prefer-software' },
  'realtime-default': { latencyMode: 'realtime' },
  'quality-software-flush3': { latencyMode: 'quality', hardwareAcceleration: 'prefer-software' }
})
export const probeColors = [
  [190, 45, 35],
  [35, 180, 55],
  [35, 55, 190]
]
export const encoderConfig = Object.freeze({
  codec: 'avc1.42400a',
  width: 64,
  height: 96,
  bitrate: 25000,
  bitrateMode: 'variable',
  alpha: 'discard',
  avc: { format: 'avc' }
})

const base64 = (bytes) => {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}
const serializeConfig = (config) =>
  config && {
    ...config,
    ...(config.description
      ? {
          descriptionBase64: base64(
            new Uint8Array(
              config.description.buffer ?? config.description,
              config.description.byteOffset ?? 0,
              config.description.byteLength
            )
          ),
          description: undefined
        }
      : {})
  }
const errorIdentity = (error) => ({
  name: error?.name ?? typeof error,
  message: error?.message ?? String(error),
  ...(typeof error?.code === 'number' ? { code: error.code } : {})
})

export async function runEncoderCase(
  name,
  {
    Encoder = globalThis.VideoEncoder,
    Frame = globalThis.VideoFrame,
    makeCanvas = () => new OffscreenCanvas(64, 96),
    setupMs = 10000,
    feedMs = 15000,
    flushMs = 10000
  } = {}
) {
  if (!(name in encoderCases)) throw Error('Unknown encoder probe case')
  const started = performance.now(),
    controller = new AbortController()
  const report = {
    candidate: name,
    requestedConfig: { ...encoderConfig, ...encoderCases[name] },
    input: { frames: 15, timestampStepUs: 100000, width: 64, height: 96, colors: probeColors },
    absentRequestedFields: [
      'framerate',
      ...(!('hardwareAcceleration' in encoderCases[name]) ? ['hardwareAcceleration'] : []),
      ...(!('latencyMode' in encoderCases[name]) ? ['latencyMode'] : [])
    ],
    specificationDefaults: { latencyMode: 'quality', hardwareAcceleration: 'no-preference' },
    backend: 'unobserved; hardwareAcceleration is only a public preference',
    flushEvery: name === 'quality-software-flush3' ? 3 : null,
    limitsMs: { setup: setupMs, feed: feedMs, flush: flushMs },
    submitted: 0,
    output: 0,
    chunks: [],
    observations: [],
    flushes: [],
    outcome: 'starting',
    userAgent: globalThis.navigator?.userAgent ?? null
  }
  let encoder,
    sampler,
    stage = 'setup',
    rejectFailure
  const failure = new Promise((_, reject) => {
    rejectFailure = reject
  })
  void failure.catch(() => {})
  const observe = (event, details = {}) =>
    report.observations.push({
      event,
      elapsedMs: Math.round(performance.now() - started),
      submitted: report.submitted,
      output: report.output,
      queueSize: encoder?.encodeQueueSize ?? null,
      state: encoder?.state ?? null,
      ...details
    })
  async function within(operation, phase, milliseconds) {
    let timer
    try {
      return await Promise.race([
        operation,
        failure,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(Error(`${phase} observation deadline`), {
                  name: 'ProbeTimeout',
                  phase
                })
              ),
            milliseconds
          )
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const waitForDequeue = () =>
    new Promise((resolve, reject) => {
      const done = () => {
        cleanup()
        resolve()
      }
      const canceled = () => {
        cleanup()
        reject(controller.signal.reason)
      }
      function cleanup() {
        encoder.removeEventListener('dequeue', done)
        controller.signal.removeEventListener('abort', canceled)
      }
      encoder.addEventListener('dequeue', done, { once: true })
      controller.signal.addEventListener('abort', canceled, { once: true })
    })
  async function flush(kind) {
    stage = kind
    const entry = {
      kind,
      submitted: report.submitted,
      startMs: Math.round(performance.now() - started),
      outcome: 'pending'
    }
    report.flushes.push(entry)
    observe('flush-start', { kind })
    try {
      await within(encoder.flush(), kind, flushMs)
      entry.outcome = 'resolved'
      entry.output = report.output
      entry.endMs = Math.round(performance.now() - started)
      observe('flush-resolved', { kind })
    } catch (error) {
      entry.outcome = error.name === 'ProbeTimeout' ? 'timeout' : 'error'
      throw error
    }
  }
  try {
    if (!Encoder || !Frame) throw Error('Public VideoEncoder/VideoFrame unavailable')
    report.support = await within(Encoder.isConfigSupported(report.requestedConfig), 'support', setupMs)
    if (!report.support.supported) {
      report.outcome = 'unsupported'
      return report
    }
    encoder = new Encoder({
      output(chunk, metadata) {
        try {
          const bytes = new Uint8Array(chunk.byteLength)
          chunk.copyTo(bytes)
          report.chunks.push({
            type: chunk.type,
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            byteLength: chunk.byteLength,
            dataBase64: base64(bytes),
            ...(metadata?.decoderConfig ? { decoderConfig: serializeConfig(metadata.decoderConfig) } : {})
          })
          report.output++
          observe('output')
        } catch (error) {
          rejectFailure(error)
        }
      },
      error(error) {
        observe('encoder-error', { error: errorIdentity(error) })
        rejectFailure(error)
      }
    })
    encoder.addEventListener('dequeue', () => observe('dequeue'), { signal: controller.signal })
    observe('configure-start')
    encoder.configure(report.requestedConfig)
    observe('configured')
    sampler = setInterval(() => observe('sample'), 250)
    const canvas = makeCanvas(),
      context = canvas.getContext('2d')
    stage = 'feed'
    // The budget includes periodic flushes, each of which also has its own deadline.
    const feedBudget = feedMs + (report.flushEvery ? 5 * flushMs : 0)
    await within(
      (async () => {
        for (let index = 0; index < 15; index++) {
          controller.signal.throwIfAborted()
          stage = 'feed'
          context.fillStyle = `rgb(${probeColors[Math.floor(index / 5)].join(',')})`
          context.fillRect(0, 0, 64, 96)
          const frame = new Frame(canvas, { timestamp: index * 100000, duration: 100000 })
          try {
            observe('encode-start')
            encoder.encode(frame, { keyFrame: index === 0 })
            report.submitted++
            observe('encoded')
          } finally {
            frame.close()
          }
          // Same public queue backpressure as MediaBunny 1.65.1 media-source.ts651.
          if (encoder.encodeQueueSize >= 4) await waitForDequeue()
          if (report.flushEvery && report.submitted % report.flushEvery === 0)
            await flush(report.submitted === 15 ? 'final-flush' : 'periodic-flush')
        }
      })(),
      'feed',
      feedBudget
    )
    if (!report.flushEvery) await flush('final-flush')
    observe('complete')
    report.outcome = report.output === 15 ? 'complete' : 'output-count-mismatch'
  } catch (error) {
    observe('failed', { error: errorIdentity(error) })
    report.failure = { phase: error.phase ?? stage, ...errorIdentity(error) }
    report.outcome = error.name === 'ProbeTimeout' ? `${error.phase}-timeout` : 'error'
  } finally {
    report.terminalBeforeClose = {
      state: encoder?.state ?? null,
      queueSize: encoder?.encodeQueueSize ?? null
    }
    clearInterval(sampler)
    controller.abort(new DOMException('Probe observation ended', 'AbortError'))
    try {
      if (encoder && encoder.state !== 'closed') encoder.close()
    } catch (error) {
      report.closeError = errorIdentity(error)
    }
    observe('closed')
    report.elapsedMs = Math.round(performance.now() - started)
  }
  return report
}

if (globalThis.mygo?.call) {
  const candidate = await globalThis.mygo.call('EncoderProbe.Case')
  const report = await runEncoderCase(candidate)
  await globalThis.mygo.call('EncoderProbe.Finish', JSON.stringify(report))
}
