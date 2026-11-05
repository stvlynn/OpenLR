import { renderPrepared as render } from './render.js'
import { geometry } from './geometry.js'
import { applyWatermark } from './export-options.js'
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
export async function openVideo(file) {
  const url = URL.createObjectURL(file),
    video = document.createElement('video')
  video.preload = 'auto'
  video.playsInline = true
  video.muted = true
  const close = () => {
    video.pause()
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
  try {
    await waitForMedia(video, 'loadeddata', () => {
      video.src = url
    })
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
    const seek = async (time) => {
      if (!(time >= 0 && time <= duration)) throw Error('Time is outside the video')
      if (Math.abs(video.currentTime - time) > 0.0001)
        await waitForMedia(video, 'seeked', () => {
          video.currentTime = time
        })
    }
    return { video, duration, seek, close }
  } catch (err) {
    close()
    throw err
  }
}
export async function poster(file) {
  const media = await openVideo(file)
  try {
    return { bitmap: await createImageBitmap(media.video), duration: media.duration }
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
export async function exportVideo(file, photo, args) {
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
  } = await import('./vendor/mediabunny/mediabunny.mjs')
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const mp4 = args.format === 'video/mp4',
      target = new BufferTarget()
    const output = new Output({ format: mp4 ? new Mp4OutputFormat() : new WebMOutputFormat(), target })
    const size = geometry(photo, photo.edit, args.maxSize ?? Infinity)
    const frame = document.createElement('canvas')
    frame.width = photo.width
    frame.height = photo.height
    const ctx = frame.getContext('2d')
    const conversion = await Conversion.init({
      input,
      output,
      trim: clipRange(photo.edit.trim, await input.computeDuration()),
      video: {
        codec: mp4 ? 'avc' : 'vp9',
        bitrate: QUALITY_HIGH,
        allowRotationMetadata: false,
        processedWidth: size.turn % 2 ? size.height : size.width,
        processedHeight: size.turn % 2 ? size.width : size.height,
        async process(sample) {
          args.signal?.throwIfAborted()
          if (frame.width !== sample.displayWidth) frame.width = sample.displayWidth
          if (frame.height !== sample.displayHeight) frame.height = sample.displayHeight
          sample.draw(ctx, 0, 0)
          const canvas = await render(frame, photo.edit, args.maxSize ?? Infinity, { signal: args.signal })
          applyWatermark(canvas, args.watermark)
          return canvas
        }
      }
    })
    if (!conversion.isValid || conversion.discardedTracks.length)
      throw Error('This device cannot encode every source track in the selected video format')
    await conversion.execute()
    return {
      blob: new Blob([target.buffer], { type: args.format }),
      filename: photo.name.replace(/\.[^.]+$/, '') + (mp4 ? '.mp4' : '.webm')
    }
  } finally {
    input.dispose()
  }
}
