import { renderPrepared as render } from './render.js'
import { geometry } from './geometry.js'
import { applyWatermark } from './export-options.js'
import { executeAudioExport, planAudioExport } from './audio-export.js'
import {
  beginVideoExportTrace,
  markVideoImport,
  markVideoSeek,
  observeVideoImportMedia,
  observeVideoPlaybackLoad,
  observeVideoSeek,
  recordVideoImportState
} from './video-import-diagnostics.js'
export const isVideo = (asset) =>
  Boolean(
    asset &&
    (asset.type?.startsWith('video/') ||
      asset.mediaType?.startsWith('video/') ||
      /\.(mov|mp4|m4v|webm|mkv)$/i.test(asset.name))
  )
function mediaError(video) {
  return Error(video.error?.message || 'The video codec is unavailable')
}

function waitForMedia(video, event, action, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    if (video.error) throw mediaError(video)
    function cleanup() {
      if (event) video.removeEventListener(event, ok)
      video.removeEventListener('error', fail)
      signal.removeEventListener('abort', abort)
    }
    function ok() {
      cleanup()
      if (video.error) reject(mediaError(video))
      else resolve()
    }
    function rejectWait(error) {
      cleanup()
      reject(error)
    }
    function fail() {
      rejectWait(mediaError(video))
    }
    function abort() {
      rejectWait(signal.reason)
    }
    if (event) video.addEventListener(event, ok)
    video.addEventListener('error', fail)
    signal.addEventListener('abort', abort, { once: true })
    try {
      const result = action()
      if (result) result.then(ok, rejectWait)
    } catch (error) {
      rejectWait(error)
    }
  })
}
function nativeVideoPixelsReadable(video) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')
  try {
    context.drawImage(video, 0, 0, 1, 1)
    context.getImageData(0, 0, 1, 1)
    return true
  } catch (error) {
    if (error.name !== 'SecurityError') throw error
    return false
  }
}

export async function openVideo(file, diagnostic, seekTrace, preparePoster = false) {
  markVideoImport(diagnostic, 'media-load')
  const url = URL.createObjectURL(file),
    video = document.createElement('video'),
    lifetime = new AbortController()
  const stopObserving = observeVideoImportMedia(diagnostic, video, url)
  video.preload = 'auto'
  video.playsInline = true
  video.muted = true
  let closed = false,
    frameSource
  const close = () => {
    if (closed) return
    closed = true
    lifetime.abort(new DOMException('The video is closed', 'AbortError'))
    stopObserving?.()
    frameSource?.then(
      (source) => source?.close(),
      () => {}
    )
    video.pause()
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
  try {
    markVideoSeek(seekTrace, 'playback-load', video)
    const stopObservingLoad = observeVideoPlaybackLoad(seekTrace, video)
    let frameCallback, frameTimer
    try {
      let presented, resolvePresentation
      if (preparePoster && typeof video.requestVideoFrameCallback === 'function') {
        presented = new Promise((resolve) => {
          resolvePresentation = resolve
        })
        frameCallback = video.requestVideoFrameCallback(() => resolvePresentation(true))
      }
      await waitForMedia(
        video,
        'loadeddata',
        () => {
          video.src = url
        },
        lifetime.signal
      )
      if (presented) {
        // WebKit can report loadeddata before the native first frame can be copied.
        // An inactive window may never send the callback, so retain the ready-frame path.
        frameTimer = setTimeout(resolvePresentation, 2000, false)
        await waitForMedia(video, null, () => presented, lifetime.signal)
        const arrived = await presented
        markVideoImport(diagnostic, arrived ? 'poster-frame-presented' : 'poster-frame-timeout', video)
      }
    } finally {
      clearTimeout(frameTimer)
      if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback)
      stopObservingLoad?.()
    }
    markVideoSeek(seekTrace, 'playback-loaded', video)
    markVideoImport(diagnostic, 'media-duration', video)
    video.width = video.videoWidth
    video.height = video.videoHeight
    let duration = video.duration
    if (!Number.isFinite(duration)) {
      const { Input, BlobSource, ALL_FORMATS } = await import('./vendor/mediabunny/mediabunny.mjs')
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
      try {
        duration = await input.computeDuration()
      } finally {
        input.dispose()
      }
    }
    if (!duration || !video.width || !video.height) throw Error('No playable video track')
    async function frames() {
      if (closed) throw new DOMException('The video is closed', 'AbortError')
      frameSource ??= (async () => {
        markVideoImport(diagnostic, 'frame-access', video)
        if (nativeVideoPixelsReadable(video)) return null
        markVideoImport(diagnostic, 'frame-decode')
        markVideoSeek(seekTrace, 'playback-frame-decoder')
        const { decodeVideoFrames } = await import('./video-frames.js')
        return decodeVideoFrames(file)
      })()
      const source = await frameSource
      if (closed) throw new DOMException('The video is closed', 'AbortError')
      return source
    }
    const seek = async (time, force = false, trace) => {
      lifetime.signal.throwIfAborted()
      if (!(time >= 0 && time <= duration)) throw Error('Time is outside the video')
      if (video.error) throw mediaError(video)
      const detail = trace && { seekTime: time }
      if (force || Math.abs(video.currentTime - time) > 0.0001) {
        markVideoSeek(trace, 'seek-start', video, detail)
        const stopObserving = observeVideoSeek(trace, video, time)
        try {
          await waitForMedia(
            video,
            'seeked',
            () => {
              video.currentTime = time
              markVideoSeek(trace, 'seek-assigned', video, detail)
            },
            lifetime.signal
          )
        } finally {
          stopObserving?.()
        }
        markVideoSeek(trace, 'seek-completed', video, detail)
      } else markVideoSeek(trace, 'seek-unchanged', video, detail)
    }
    async function frameAt(time = video.currentTime) {
      const source = await frames()
      markVideoImport(diagnostic, 'frame-read', video)
      return source ? source.at(time) : video
    }
    return {
      video,
      duration,
      seek,
      close,
      frameAt,
      play() {
        return waitForMedia(video, null, () => video.play(), lifetime.signal)
      },
      async pauseFrame(isCurrent, trace) {
        markVideoSeek(trace, 'pause-start', video)
        const beforePause = video.currentTime
        video.pause()
        const time = Math.max(beforePause, video.currentTime)
        try {
          markVideoSeek(trace, 'pause-frame', video)
          const image = await frameAt(time)
          markVideoSeek(trace, 'pause-frame-read', video)
          // Anchor a paused clock before it can fall back to the previous seek.
          if (!closed && isCurrent() && video.paused) await seek(time, true, trace)
          markVideoSeek(trace, 'pause-completed', video)
          return !closed && isCurrent() ? image : null
        } catch (error) {
          markVideoSeek(trace, 'pause-failed', video)
          throw error
        }
      },
      async snapshot() {
        const source = await frames()
        const time = video.currentTime
        const image = source ? await source.at(time) : await createImageBitmap(video)
        return { time, image }
      },
      async playbackFrames() {
        return (await frames())?.playback(video.currentTime) ?? null
      }
    }
  } catch (err) {
    recordVideoImportState(diagnostic, video)
    close()
    throw err
  }
}
export async function poster(file, diagnostic) {
  const media = await openVideo(file, diagnostic, undefined, globalThis.openlrNativePlatform === 'darwin')
  try {
    const frame = await media.frameAt()
    markVideoImport(diagnostic, 'poster-bitmap', media.video)
    return { bitmap: await createImageBitmap(frame), duration: media.duration }
  } finally {
    media.close()
  }
}
export function clipRange(trim, duration) {
  if (!trim) return { start: 0, end: duration }
  const { start, end } = trim
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration + 0.001 || end <= start)
    throw Error('Trim must fit within the video duration')
  return { start, end: Math.min(end, duration) }
}
export async function exportVideo(file, photo, args, { encode, decodeAac } = {}) {
  const trace = beginVideoExportTrace(args.format)
  trace?.('module-load')
  const media = await import('./vendor/mediabunny/mediabunny.mjs')
  const {
    Input,
    BlobSource,
    ALL_FORMATS,
    Output,
    BufferTarget,
    Mp4OutputFormat,
    WebMOutputFormat,
    Conversion,
    QUALITY_HIGH
  } = media
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const mp4 = args.format === 'video/mp4',
      target = new BufferTarget()
    const format = mp4 ? new Mp4OutputFormat() : new WebMOutputFormat()
    trace?.('duration')
    if (!(await input.getPrimaryVideoTrack())) throw Error('No playable video track')
    const trim = clipRange(photo.edit.trim, await input.computeDuration())
    trace?.('audio-plan')
    const audioPlan = await planAudioExport(media, input, format, mp4, {
      signal: args.signal,
      encode,
      decodeAac
    })
    trace?.('audio-planned')
    const output = new Output({ format: audioPlan?.outputFormat ?? format, target })
    let firstFrame = true
    const video = async (track, signal) => {
      const [width, height] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight()])
      const size = geometry({ width, height }, photo.edit, args.maxSize ?? Infinity)
      const frame = document.createElement('canvas')
      frame.width = width
      frame.height = height
      const ctx = frame.getContext('2d')
      return {
        codec: mp4 ? 'avc' : 'vp9',
        bitrate: QUALITY_HIGH,
        allowRotationMetadata: false,
        processedWidth: size.turn % 2 ? size.height : size.width,
        processedHeight: size.turn % 2 ? size.width : size.height,
        async process(sample) {
          if (firstFrame) trace?.('first-frame')
          signal?.throwIfAborted()
          if (frame.width !== sample.displayWidth) frame.width = sample.displayWidth
          if (frame.height !== sample.displayHeight) frame.height = sample.displayHeight
          sample.draw(ctx, 0, 0)
          const canvas = await render(frame, photo.edit, args.maxSize ?? Infinity, { signal })
          applyWatermark(canvas, args.watermark)
          if (firstFrame) trace?.('first-frame-rendered')
          firstFrame = false
          return canvas
        }
      }
    }
    if (audioPlan) {
      await executeAudioExport(media, {
        input,
        output,
        trim,
        video,
        plan: audioPlan,
        signal: args.signal,
        trace
      })
    } else {
      trace?.('conversion-init')
      const conversion = await Conversion.init({
        input,
        output,
        trim,
        video: (track) => video(track, args.signal)
      })
      if (!conversion.isValid || conversion.discardedTracks.length)
        throw Error('This device cannot encode every source track in the selected video format')
      trace?.('conversion-execute')
      await conversion.execute()
    }
    trace?.('output-ready')
    return {
      blob: new Blob([target.buffer], { type: args.format }),
      filename: photo.name.replace(/\.[^.]+$/, '') + (mp4 ? '.mp4' : '.webm')
    }
  } finally {
    trace?.('input-dispose')
    input.dispose()
  }
}
