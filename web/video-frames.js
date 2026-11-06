import { ALL_FORMATS, BlobSource, CanvasSink, Input } from './vendor/mediabunny/mediabunny.mjs'

function playbackCursor(frames) {
  let current, next, done, closed
  return {
    async at(time) {
      while (!closed && !done && (!next || next.timestamp <= time)) {
        if (next) current = next
        const frame = await frames.next()
        if (closed) return null
        next = frame.value
        done = frame.done
      }
      return (current ?? next)?.canvas ?? null
    },
    close() {
      if (closed) return
      closed = true
      current = next = null
      // A pending read may be canceled when its input closes.
      void frames.return().catch(() => {})
    }
  }
}

export async function decodeVideoFrames(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw Error('No playable video track')
    const first = await track.getFirstTimestamp()
    // Keep each published canvas independent of the next decoded frame.
    const sink = new CanvasSink(track, { alpha: true })
    let last
    function timestamp(time) {
      return Math.max(first, time)
    }
    return {
      at(time) {
        const requested = timestamp(time)
        if (last?.time !== requested) {
          const pending = sink
            .getCanvas(requested)
            .then((frame) => {
              if (!frame) throw Error('No decoded video frame')
              return frame.canvas
            })
            .catch((error) => {
              if (last?.pending === pending) last = null
              throw error
            })
          last = { time: requested, pending }
        }
        return last.pending
      },
      playback(time) {
        const cursor = playbackCursor(sink.canvases(timestamp(time)))
        return { at: (current) => cursor.at(timestamp(current)), close: cursor.close }
      },
      close() {
        last = null
        input.dispose()
      }
    }
  } catch (error) {
    input.dispose()
    throw error
  }
}
