import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { serveWorkspace } from '../tests/browser-server.mjs'

const cases = [
  ['opus-48000-mono', 'opus', 48000, 1],
  ['opus-48000-stereo', 'opus', 48000, 2],
  ['aac-48000-mono', 'aac', 48000, 1],
  ['aac-48000-stereo', 'aac', 48000, 2],
  ['aac-44100-stereo', 'aac', 44100, 2]
]
const stages = [
  'encoder-create',
  'encoder-format',
  'encode',
  'encoder-cookie',
  'decoder-create',
  'decoder-cookie',
  'decode',
  'complete'
]
const decoderStages = ['decoder-create', 'decoder-cookie', 'decoder-prime-method', 'decode', 'complete']
const opusDecoderVariants = [
  'encoder-cookie-default',
  'no-cookie-default',
  'opushead-zero-default',
  'encoder-cookie-no-prime',
  'opushead-312-default'
]
const pcmWindowStart = 6400,
  pcmWindowFrames = 1600,
  maxLag = 1024

function integer(value, low = 0) {
  assert.ok(Number.isSafeInteger(value) && value >= low)
}

function status(value) {
  integer(value, -2147483648)
  assert.ok(value <= 2147483647)
}

function hex(value) {
  assert.equal(typeof value, 'string')
  assert.match(value, /^(?:[0-9a-f]{2})*$/)
}

function optionalStatus(value) {
  if (value !== null) status(value)
}

function validatePrime(prime) {
  optionalStatus(prime.status)
  if (prime.status === 0) {
    integer(prime.leading)
    integer(prime.trailing)
  }
}

function validateSignal(signal, frames, channels) {
  assert.equal(signal.length, frames ? channels : 0)
  for (const { peak, pulseOffset, toneAmplitude } of signal) {
    integer(pulseOffset, -9601)
    assert.ok(Number.isFinite(peak) && peak >= 0)
    assert.ok(Number.isFinite(toneAmplitude) && toneAmplitude >= 0)
  }
}

function validateOpusVariants(candidate) {
  const { codec, stage, channels, packets } = candidate
  const variants = candidate.opusDecoderVariants
  const expected = codec === 'opus' && decoderStages.includes(stage) ? opusDecoderVariants : []
  assert.deepEqual(
    variants.map(({ name }) => name),
    expected
  )
  for (const variant of variants) {
    assert.ok(decoderStages.includes(variant.stage))
    status(variant.status)
    assert.equal(variant.status === 0, variant.stage === 'complete')
    integer(variant.decodedFrames)
    integer(variant.firstFrames)
    integer(variant.firstPackets)
    assert.ok(variant.firstFrames <= variant.decodedFrames && variant.firstPackets <= packets.length)
    if (variant.stage === 'complete') assert.ok(variant.decodedFrames > 0 && variant.firstFrames > 0)
    optionalStatus(variant.cookieStatus)
    optionalStatus(variant.setPrimeMethodStatus)
    optionalStatus(variant.primeMethod.status)
    if (variant.primeMethod.status === 0) integer(variant.primeMethod.value)
    validatePrime(variant.prime)
    validateSignal(variant.signal, variant.decodedFrames, channels)
    if (variant.decodedFrames >= pcmWindowStart + pcmWindowFrames) {
      hex(variant.pcmWindowF32le)
      assert.equal(variant.pcmWindowF32le.length, pcmWindowFrames * channels * 8)
    } else assert.equal(variant.pcmWindowF32le, null)
  }
  if (variants.length) {
    const [base] = variants
    for (const key of ['stage', 'status', 'decodedFrames', 'signal'])
      assert.deepEqual(base[key], candidate[key])
    assert.deepEqual(base.prime, candidate.decoderPrime)
  }
}

export function parseAudioProbeReport(text) {
  const report = JSON.parse(text)
  for (const formats of [report.encodeFormats, report.decodeFormats]) {
    status(formats.status)
    assert.equal(typeof formats.aac, 'boolean')
    assert.equal(typeof formats.opus, 'boolean')
  }
  assert.equal(report.candidates.length, cases.length, 'Incomplete AudioToolbox probe')
  for (const [index, candidate] of report.candidates.entries()) {
    const { name, codec, sampleRate, channels, stage, inputFrames, packets, signal } = candidate
    assert.deepEqual([name, codec, sampleRate, channels], cases[index])
    assert.ok(stages.includes(stage))
    status(candidate.status)
    assert.equal(candidate.status === 0, stage === 'complete')
    assert.equal(inputFrames, 9601)
    integer(candidate.codedFrames)
    integer(candidate.decodedFrames)
    integer(candidate.framesPerPacket)
    for (const prime of [candidate.encoderPrime, candidate.decoderPrime]) validatePrime(prime)
    optionalStatus(candidate.cookieStatus)
    hex(candidate.cookie)
    assert.ok(candidate.cookie.length <= 8192)
    assert.ok(Array.isArray(packets) && packets.length <= 64)
    for (const packet of packets) {
      integer(packet.frames, 1)
      hex(packet.data)
      assert.ok(packet.data.length > 0)
    }
    assert.equal(
      packets.reduce((sum, packet) => sum + packet.frames, 0),
      candidate.codedFrames
    )
    validateSignal(signal, candidate.decodedFrames, channels)
    validateOpusVariants(candidate)
    if (stage === 'complete') {
      assert.ok(candidate.codedFrames >= inputFrames && candidate.decodedFrames > 0)
      for (const value of [
        candidate.encoderPrime.status,
        candidate.decoderPrime.status,
        candidate.cookieStatus
      ])
        assert.notEqual(value, null)
    }
  }
  return report
}

// The Chrome window has maxLag extra frames before and after the native window.
export function compareOpusProbeWindows(native, reference, channels) {
  const power = native.reduce((sum, value) => sum + value * value, 0)
  if (!(power > 0) || !Number.isFinite(power) || reference.length !== native.length + 2 * maxLag * channels)
    return null
  let bestError = Infinity,
    bestOffset = 0
  for (let offset = -maxLag; offset <= maxLag; offset++) {
    const start = (offset + maxLag) * channels
    let error = 0
    for (let i = 0; i < native.length; i++) {
      const difference = native[i] - reference[start + i]
      error += difference * difference
    }
    if (error < bestError) {
      bestError = error
      bestOffset = offset
    }
  }
  if (!Number.isFinite(bestError)) return null
  return { referenceFrameOffset: bestOffset, relativeRmsError: Math.sqrt(bestError / power) }
}

async function decodeNativePackets(candidates) {
  const { chromium } = await import('playwright-core')
  const server = await serveWorkspace()
  let browser, deadline
  try {
    browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
    const page = await browser.newPage()
    await page.route(server.url + '/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Audio codec oracle</title>' })
    )
    await page.goto(server.url)
    const input = {
      candidates,
      startFrame: pcmWindowStart - maxLag,
      windowFrames: pcmWindowFrames + 2 * maxLag
    }
    const evaluation = page.evaluate(async ({ candidates, startFrame, windowFrames }) => {
      const results = {}
      for (const { name, codec, sampleRate, channels, packets } of candidates) {
        const config = {
          codec: codec === 'opus' ? 'opus' : 'mp4a.40.2',
          sampleRate,
          numberOfChannels: channels
        }
        if (codec === 'aac') {
          // AAC-LC AudioSpecificConfig for the negotiated rate and channel count of this fixture.
          const rateIndex = sampleRate === 48000 ? 3 : 4
          config.description = Uint8Array.of(
            (2 << 3) | (rateIndex >> 1),
            ((rateIndex & 1) << 7) | (channels << 3)
          )
        }
        let supported = false
        try {
          supported =
            typeof AudioDecoder === 'function' && (await AudioDecoder.isConfigSupported(config)).supported
        } catch (error) {
          results[name] = { stage: 'capability', errorName: error.name }
          continue
        }
        if (!supported) {
          results[name] = { stage: 'unsupported' }
          continue
        }
        let frames = 0,
          failure,
          channelMismatch = false
        const peaks = Array.from({ length: channels }, () => ({ value: 0, frame: 0 }))
        const pcmWindow = codec === 'opus' ? new Float32Array(windowFrames * channels) : null
        const decoder = new AudioDecoder({
          error: (error) => {
            failure = error
          },
          output: (audio) => {
            try {
              if (audio.numberOfChannels !== channels || audio.sampleRate !== sampleRate) {
                channelMismatch = true
                return
              }
              const samples = new Float32Array(audio.numberOfFrames * channels)
              audio.copyTo(samples, { format: 'f32', planeIndex: 0 })
              if (pcmWindow) {
                const start = Math.max(frames, startFrame)
                const end = Math.min(frames + audio.numberOfFrames, startFrame + windowFrames)
                if (start < end)
                  pcmWindow.set(
                    samples.subarray((start - frames) * channels, (end - frames) * channels),
                    (start - startFrame) * channels
                  )
              }
              for (let i = 0; i < audio.numberOfFrames; i++)
                for (let channel = 0; channel < channels; channel++) {
                  const frame = frames + i
                  if (frame < sampleRate / 8) continue
                  const value = Math.abs(samples[i * channels + channel])
                  if (value > peaks[channel].value) peaks[channel] = { value, frame }
                }
              frames += audio.numberOfFrames
            } catch (error) {
              failure = error
            } finally {
              audio.close()
            }
          }
        })
        try {
          decoder.configure(config)
          let timestamp = 0
          for (const packet of packets) {
            const data = Uint8Array.from(packet.data.match(/../g), (value) => parseInt(value, 16))
            decoder.decode(
              new EncodedAudioChunk({
                type: 'key',
                data,
                timestamp: Math.round((timestamp * 1e6) / sampleRate),
                duration: Math.round((packet.frames * 1e6) / sampleRate)
              })
            )
            timestamp += packet.frames
          }
          let deadline
          try {
            await Promise.race([
              decoder.flush(),
              new Promise((_, reject) => {
                deadline = setTimeout(
                  () => reject(new DOMException('Decoder deadline', 'TimeoutError')),
                  5000
                )
              })
            ])
          } finally {
            clearTimeout(deadline)
          }
          if (failure) throw failure
          results[name] = {
            stage: 'complete',
            decodedFrames: frames,
            formatMatches: !channelMismatch,
            pcmWindow:
              pcmWindow && !channelMismatch && frames >= startFrame + windowFrames
                ? Array.from(pcmWindow)
                : null,
            peaks: peaks.map(({ value, frame }) => ({
              value,
              pulseOffset: frame - Math.floor((sampleRate * 145) / 1000)
            }))
          }
        } catch (error) {
          results[name] = { stage: 'decode', errorName: error.name }
        } finally {
          if (decoder.state !== 'closed') decoder.close()
        }
      }
      return results
    }, input)
    return await Promise.race([
      evaluation,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(Error('AudioToolbox browser oracle timed out')), 30000)
      })
    ])
  } finally {
    clearTimeout(deadline)
    try {
      await browser?.close()
    } finally {
      server.close()
    }
  }
}

async function main(executable) {
  if (!executable) throw Error('Pass a built AudioToolbox probe executable')
  const { stdout, stderr } = await promisify(execFile)(path.resolve(executable), [], {
    timeout: 15000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024
  }).catch((error) => {
    if (error.stderr) process.stderr.write(error.stderr)
    throw new Error(
      error.killed ? 'AudioToolbox probe timed out' : `AudioToolbox probe failed (${error.code})`
    )
  })
  if (stderr) process.stderr.write(stderr)
  const report = parseAudioProbeReport(stdout)
  const encoded = report.candidates
    .filter(({ packets }) => packets.length)
    .map(({ name, codec, sampleRate, channels, packets }) => ({ name, codec, sampleRate, channels, packets }))
  console.log(
    JSON.stringify({ nativeAudio: 'formats', encode: report.encodeFormats, decode: report.decodeFormats })
  )
  for (const { name, cookie, packets, opusDecoderVariants: variants, ...candidate } of report.candidates) {
    const { codedFrames, inputFrames, encoderPrime, signal } = candidate
    const padding = codedFrames - inputFrames - encoderPrime.leading
    console.log(
      JSON.stringify({
        nativeAudio: 'candidate',
        name,
        ...candidate,
        packetFrames: packets.map(({ frames }) => frames),
        cookieBytes: cookie.length / 2,
        ...(candidate.codec === 'opus'
          ? { cookieHex: cookie, firstPacketToc: packets[0]?.data.slice(0, 2) ?? null }
          : {}),
        impliedEndPadding:
          candidate.stage === 'complete' && encoderPrime.status === 0 && padding >= 0 ? padding : null,
        signalMatches:
          candidate.stage === 'complete' &&
          candidate.decodedFrames >= inputFrames &&
          signal.every(({ peak, toneAmplitude }) => peak > 0.25 && toneAmplitude > 0.1)
      })
    )
    for (const { name: variant, pcmWindowF32le, ...result } of variants)
      console.log(JSON.stringify({ nativeAudio: 'opus-decoder-variant', name, variant, ...result }))
  }
  if (encoded.length) {
    const chrome = await decodeNativePackets(encoded)
    for (const { name, channels, opusDecoderVariants: variants } of report.candidates) {
      if (!encoded.some((candidate) => candidate.name === name)) continue
      assert.ok(chrome[name], `Missing Chrome decoder outcome for ${name}`)
      const { pcmWindow, ...result } = chrome[name]
      console.log(JSON.stringify({ nativeAudio: 'chrome', name, ...result }))
      for (const { name: variant, stage, pcmWindowF32le } of variants) {
        let comparison = null
        if (stage === 'complete' && pcmWindow && pcmWindowF32le) {
          const bytes = Buffer.from(pcmWindowF32le, 'hex')
          const samples = Float32Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4))
          comparison = compareOpusProbeWindows(samples, pcmWindow, channels)
        }
        console.log(JSON.stringify({ nativeAudio: 'opus-pcm-comparison', name, variant, comparison }))
      }
    }
  }
  console.log(JSON.stringify({ nativeAudio: 'complete' }))
}

if (import.meta.main) await main(process.argv[2])
