const MOVIE_TIMESCALE = 57_600
const MAX_MOVIE_TIMESCALE = 0xffffffff

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw RangeError('Invalid audio ' + name)
}

function frameCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw RangeError('Invalid audio ' + name)
}

function frameAt(time, sampleRate) {
  const frame = Math.round(time * sampleRate)
  if (!Number.isFinite(time) || !Number.isSafeInteger(frame))
    throw RangeError('Audio timestamp cannot be represented at its sample rate')
  return frame
}

// Half-open source bounds on the sample clock. Output zero is always the
// requested trim start, even if this track becomes audible later.
export function audioTrimFrames(trim, sampleRate, presentation) {
  positiveInteger(sampleRate, 'sample rate')
  if (trim.start < 0 || !(trim.start < trim.end)) throw RangeError('Invalid audio trim interval')
  const origin = frameAt(trim.start, sampleRate),
    limit = frameAt(trim.end, sampleRate)
  if (!presentation) return origin < limit ? { start: origin, end: limit, outputStart: 0 } : null
  if (!(presentation.start < presentation.end)) throw RangeError('Invalid audio presentation interval')
  const start = Math.max(origin, frameAt(presentation.start, sampleRate)),
    end = Math.min(limit, frameAt(presentation.end, sampleRate))
  return start < end ? { start, end, outputStart: start - origin } : null
}

// The encoder's completed coded count is authoritative for final discard.
// Its reported prime metadata may describe input buffering as well.
export function audioTailFrames(codedFrames, leadingFrames, audibleFrames) {
  frameCount(codedFrames, 'coded frame count')
  frameCount(leadingFrames, 'leading frame count')
  positiveInteger(audibleFrames, 'audible frame count')
  const tail = codedFrames - leadingFrames - audibleFrames
  if (tail < 0) throw RangeError('Encoded audio does not cover the requested samples')
  return tail
}

export function audioPacketTiming({
  sampleRate,
  outputStart,
  leadingFrames,
  codedBefore,
  packetFrames,
  tailFrames = 0
}) {
  positiveInteger(sampleRate, 'sample rate')
  frameCount(outputStart, 'output start frame')
  frameCount(leadingFrames, 'leading frame count')
  frameCount(codedBefore, 'packet position')
  positiveInteger(packetFrames, 'packet frame count')
  frameCount(tailFrames, 'trailing frame count')
  const start = outputStart - leadingFrames + codedBefore
  if (!Number.isSafeInteger(start)) throw RangeError('Audio packet timestamp exceeds the sample clock')
  const sideData = {}
  if (codedBefore === 0) sideData.audioPriming = leadingFrames / sampleRate
  if (tailFrames > 0) sideData.audioDiscardPadding = tailFrames / sampleRate
  return { timestamp: start / sampleRate, duration: packetFrames / sampleRate, sideData }
}

export function audioMovieTimescale(sampleRates) {
  let timescale = MOVIE_TIMESCALE
  for (const rate of sampleRates) {
    positiveInteger(rate, 'sample rate')
    let a = timescale,
      b = rate
    while (b) [a, b] = [b, a % b]
    timescale = (timescale / a) * rate
    if (timescale > MAX_MOVIE_TIMESCALE)
      throw RangeError('MP4 cannot represent these audio sample rates exactly')
  }
  return timescale
}
