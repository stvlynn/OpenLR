import { renderPrepared as render } from './render.js'
import { geometry } from './geometry.js'
import { applyWatermark } from './export-options.js'
import { executeAudioExport, planAudioExport } from './audio-export.js'
export const isVideo = (asset) =>
  Boolean(
    asset &&
    (asset.type?.startsWith('video/') ||
      asset.mediaType?.startsWith('video/') ||
      /\.(mov|mp4|m4v|webm|mkv)$/i.test(asset.name))
  )
function waitForMedia(video, event, action) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      video.removeEventListener(event, ok)
      video.removeEventListener('error', fail)
    }
    function ok() {
      cleanup()
      resolve()
    }
    function fail() {
      cleanup()
      reject(Error(video.error?.message || 'The video codec is unavailable'))
    }
    video.addEventListener(event, ok)
    video.addEventListener('error', fail)
    action()
  })
}
function recordMediaState(diagnostic, video) {
  if (!diagnostic) return
  diagnostic.readyState = video.readyState
  diagnostic.networkState = video.networkState
  diagnostic.width = video.videoWidth
  diagnostic.height = video.videoHeight
  diagnostic.mediaErrorCode = video.error?.code ?? null
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

export async function openVideo(file, diagnostic) {
  if (diagnostic) diagnostic.stage = 'media-load'
  const url = URL.createObjectURL(file),
    video = document.createElement('video')
  if (diagnostic) {
    const origin = new URL(url).origin
    diagnostic.blobOrigin = origin === 'null' ? 'opaque' : origin === location.origin ? 'same' : 'different'
  }
  video.preload = 'auto'
  video.playsInline = true
  video.muted = true
  let closed = false,
    frameSource
  const close = () => {
    if (closed) return
    closed = true
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
    await waitForMedia(video, 'loadeddata', () => {
      video.src = url
    })
    if (diagnostic) diagnostic.stage = 'media-duration'
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
        if (diagnostic) diagnostic.stage = 'frame-access'
        if (nativeVideoPixelsReadable(video)) return null
        if (diagnostic) diagnostic.stage = 'frame-decode'
        const { decodeVideoFrames } = await import('./video-frames.js')
        return decodeVideoFrames(file)
      })()
      const source = await frameSource
      if (closed) throw new DOMException('The video is closed', 'AbortError')
      return source
    }
    const seek = async (time, force = false) => {
      if (!(time >= 0 && time <= duration)) throw Error('Time is outside the video')
      if (force || Math.abs(video.currentTime - time) > 0.0001)
        await waitForMedia(video, 'seeked', () => {
          video.currentTime = time
        })
    }
    async function frameAt(time = video.currentTime) {
      const source = await frames()
      return source ? source.at(time) : video
    }
    return {
      video,
      duration,
      seek,
      close,
      frameAt,
      async pauseFrame(isCurrent) {
        const beforePause = video.currentTime
        video.pause()
        const time = Math.max(beforePause, video.currentTime)
        const image = await frameAt(time)
        // Anchor a paused clock before it can fall back to the previous seek.
        if (!closed && isCurrent() && video.paused) await seek(time, true)
        return !closed && isCurrent() ? image : null
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
    recordMediaState(diagnostic, video)
    close()
    throw err
  }
}
export async function poster(file, diagnostic) {
  const media = await openVideo(file, diagnostic)
  try {
    recordMediaState(diagnostic, media.video)
    const frame = await media.frameAt()
    if (diagnostic) diagnostic.stage = 'poster-bitmap'
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
    const trim = clipRange(photo.edit.trim, await input.computeDuration())
    const audioPlan = await planAudioExport(media, input, format, mp4, {
      signal: args.signal,
      encode,
      decodeAac
    })
    const output = new Output({ format: audioPlan?.outputFormat ?? format, target })
    const size = geometry(photo, photo.edit, args.maxSize ?? Infinity)
    const frame = document.createElement('canvas')
    frame.width = photo.width
    frame.height = photo.height
    const ctx = frame.getContext('2d')
    const video = (signal) => ({
      codec: mp4 ? 'avc' : 'vp9',
      bitrate: QUALITY_HIGH,
      allowRotationMetadata: false,
      processedWidth: size.turn % 2 ? size.height : size.width,
      processedHeight: size.turn % 2 ? size.width : size.height,
      async process(sample) {
        signal?.throwIfAborted()
        if (frame.width !== sample.displayWidth) frame.width = sample.displayWidth
        if (frame.height !== sample.displayHeight) frame.height = sample.displayHeight
        sample.draw(ctx, 0, 0)
        const canvas = await render(frame, photo.edit, args.maxSize ?? Infinity, { signal })
        applyWatermark(canvas, args.watermark)
        return canvas
      }
    })
    if (audioPlan) {
      await executeAudioExport(media, {
        input,
        output,
        trim,
        video,
        plan: audioPlan,
        signal: args.signal
      })
    } else {
      const conversion = await Conversion.init({ input, output, trim, video: video(args.signal) })
      if (!conversion.isValid || conversion.discardedTracks.length)
        throw Error('This device cannot encode every source track in the selected video format')
      await conversion.execute()
    }
    return {
      blob: new Blob([target.buffer], { type: args.format }),
      filename: photo.name.replace(/\.[^.]+$/, '') + (mp4 ? '.mp4' : '.webm')
    }
  } finally {
    input.dispose()
  }
}
