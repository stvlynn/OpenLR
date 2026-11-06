import { openVideo, poster } from './video.js'
import { render, toBlob } from './render.js'
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from './vendor/mediabunny/mediabunny.mjs'

const errorNames = new Set([
  'Error',
  'SecurityError',
  'NotAllowedError',
  'NotSupportedError',
  'InvalidStateError',
  'TypeError'
])
const errorName = (error) => (errorNames.has(error.name) ? error.name : 'other')
const times = [0, 2.35]

function originKind(url) {
  const origin = new URL(url).origin
  return origin === 'null' ? 'opaque' : origin === location.origin ? 'same' : 'different'
}

function mediaState(video) {
  return {
    readyState: video.readyState,
    networkState: video.networkState,
    width: video.videoWidth,
    height: video.videoHeight,
    mediaErrorCode: video.error?.code ?? null
  }
}

async function outcome(operation) {
  try {
    return { value: await operation() }
  } catch (error) {
    return { errorName: errorName(error) }
  }
}

async function capture(canvas, time) {
  const { width, height } = canvas
  const read = await outcome(() =>
    Array.from(canvas.getContext('2d').getImageData(width >> 1, height >> 1, 1, 1).data)
  )
  const encode = await outcome(async () => {
    const png = await toBlob(canvas, 'image/png')
    return btoa(String.fromCharCode(...new Uint8Array(await png.arrayBuffer())))
  })
  return { time, size: [width, height], read, encode }
}

function stage(value) {
  return globalThis.mygo.call('VideoProbe.Stage', value)
}

async function candidate(name, run) {
  await stage(`${name}-start`)
  const report = { stage: 'input', frames: [] }
  try {
    await run(report)
    report.stage = 'complete'
  } catch (error) {
    report.errorName = errorName(error)
  }
  await stage(`${name}-end`)
  return report
}

function waitMedia(video, event, start) {
  return new Promise((resolve, reject) => {
    function finished(error) {
      video.removeEventListener(event, ready)
      video.removeEventListener('error', failed)
      if (error) reject(error)
      else resolve()
    }
    const ready = () => finished(),
      failed = () => finished(Error('Media element error'))
    video.addEventListener(event, ready)
    video.addEventListener('error', failed)
    start()
  })
}

async function openAnonymous(file, report) {
  const video = document.createElement('video'),
    url = URL.createObjectURL(file)
  video.preload = 'auto'
  video.playsInline = true
  video.muted = true
  video.crossOrigin = 'anonymous'
  report.blobOrigin = originKind(url)
  const close = () => {
    video.pause()
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
  try {
    await waitMedia(video, 'loadeddata', () => {
      video.src = url
    })
    video.width = video.videoWidth
    video.height = video.videoHeight
    return {
      video,
      async seek(time) {
        if (Math.abs(video.currentTime - time) > 0.0001)
          await waitMedia(video, 'seeked', () => {
            video.currentTime = time
          })
      },
      close
    }
  } catch (error) {
    Object.assign(report, mediaState(video))
    close()
    throw error
  }
}

function elementPath(name, file, open) {
  return candidate(name, async (report) => {
    report.stage = 'media-load'
    const media = await open(file, report)
    try {
      report.blobOrigin = originKind(media.video.currentSrc)
      Object.assign(report, mediaState(media.video))
      for (const time of times) {
        report.stage = 'seek'
        await media.seek(time)
        report.stage = 'draw'
        report.frames.push(await capture(render(media.video, {}, 240), time))
      }
    } finally {
      media.close()
    }
  })
}

const animationFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

function playbackPath(name, file, { attach, stream, restore, delayMs } = {}) {
  return candidate(name, async (report) => {
    const reads = (report.reads = {})
    report.stage = 'media-load'
    const media = await openVideo(file, report),
      { video } = media
    let cursor
    const read = (phase) => (reads[phase] = { time: video.currentTime, paused: video.paused })
    try {
      if (attach) document.body.append(video)
      report.stage = 'seek'
      await media.seek(0.35)
      report.stage = 'frame-access'
      report.frameSource = (await media.frameAt()) === video ? 'element' : 'decoded'
      report.stage = 'play'
      video.muted = false
      await video.play()
      const started = read('started').time
      if (stream) cursor = await media.playbackFrames()

      report.stage = 'advance'
      while (!video.paused && video.currentTime < started + 0.15) {
        if (cursor) await cursor.at(video.currentTime)
        await animationFrame()
      }
      if (video.paused) throw Error('Playback ended before pause observation')
      read('advanced')

      report.stage = 'pause'
      const paused = new Promise((resolve) => {
        video.addEventListener('pause', () => resolve(read('pauseEvent')), { once: true })
      })
      const position = read('beforePause').time
      video.pause()
      read('immediate')
      cursor?.close()
      await paused
      await animationFrame()
      read('animationFrame')

      const observationStart = performance.now()
      let stopped
      if (delayMs !== undefined) {
        report.stage = 'delay'
        report.requestedDelayMs = delayMs
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        stopped = read('afterDelay').time
      } else {
        report.stage = 'frame-access'
        await media.frameAt()
        stopped = read('afterFrame').time
      }
      report.observationMs = performance.now() - observationStart
      report.playedDuration = Array.from(
        { length: video.played.length },
        (_, index) => video.played.end(index) - video.played.start(index)
      ).reduce((sum, duration) => sum + duration, 0)
      if (restore && stopped < position) {
        report.stage = 'restore'
        await media.seek(position)
        read('restored')
        await media.frameAt()
        read('restoredAfterFrame')
      }
    } finally {
      cursor?.close()
      media.close()
      video.remove()
    }
  })
}

await stage('renderer-start')
const { candidate: name, encoded, delayMs } = await globalThis.mygo.call('VideoProbe.Fixture')
const file = new File(
  [Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))],
  'fixture.webm',
  {
    type: 'video/webm'
  }
)
const context = {
  secureContext: isSecureContext,
  documentOrigin: location.origin === 'null' ? 'opaque' : 'tuple',
  nativeScheme: location.protocol === 'mygo:',
  videoDecoder: typeof VideoDecoder === 'function',
  videoEncoder: typeof VideoEncoder === 'function',
  audioDecoder: typeof AudioDecoder === 'function',
  audioEncoder: typeof AudioEncoder === 'function'
}
const paths = {
  'clock-detached': () => playbackPath(name, file),
  'clock-delay': () => playbackPath(name, file, { delayMs }),
  'clock-attached': () => playbackPath(name, file, { attach: true }),
  'clock-frame-stream': () => playbackPath(name, file, { stream: true }),
  'clock-restore': () => playbackPath(name, file, { restore: true }),
  direct: () => elementPath('direct', file, openVideo),
  poster: () =>
    candidate('poster', async (report) => {
      const { bitmap } = await poster(file, report)
      try {
        report.stage = 'draw'
        report.frames.push(await capture(render(bitmap, {}, 240), 0))
      } finally {
        bitmap.close()
      }
    }),
  anonymous: () => elementPath('anonymous', file, openAnonymous),
  decoded: () =>
    candidate('decoded', async (report) => {
      report.stage = 'demux'
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
      try {
        const track = await input.getPrimaryVideoTrack()
        if (!track) throw Error('No video track')
        const sink = new CanvasSink(track)
        for (const time of times) {
          report.stage = 'decode'
          const frame = await sink.getCanvas(time)
          if (!frame) throw Error('No video frame')
          report.stage = 'draw'
          report.frames.push(await capture(render(frame.canvas, {}, 240), time))
        }
      } finally {
        input.dispose()
      }
    })
}
const result = await paths[name]()
await globalThis.mygo.call('VideoProbe.Finish', JSON.stringify({ candidate: name, context, result }))
