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
    for (const prime of [candidate.encoderPrime, candidate.decoderPrime]) {
      if (prime.status !== null) status(prime.status)
      if (prime.status === 0) {
        integer(prime.leading)
        integer(prime.trailing)
      }
    }
    if (candidate.cookieStatus !== null) status(candidate.cookieStatus)
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
    assert.equal(signal.length, candidate.decodedFrames ? channels : 0)
    for (const { peak, pulseOffset, toneAmplitude } of signal) {
      integer(pulseOffset, -9601)
      assert.ok(Number.isFinite(peak) && peak >= 0)
      assert.ok(Number.isFinite(toneAmplitude) && toneAmplitude >= 0)
    }
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
    const evaluation = page.evaluate(async (candidates) => {
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
    }, candidates)
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
  const encoded = report.candidates.filter(({ packets }) => packets.length)
  console.log(
    JSON.stringify({ nativeAudio: 'formats', encode: report.encodeFormats, decode: report.decodeFormats })
  )
  for (const { name, cookie, packets, ...candidate } of report.candidates) {
    const { codedFrames, inputFrames, encoderPrime, signal } = candidate
    const padding = codedFrames - inputFrames - encoderPrime.leading
    console.log(
      JSON.stringify({
        nativeAudio: 'candidate',
        name,
        ...candidate,
        packetFrames: packets.map(({ frames }) => frames),
        cookieBytes: cookie.length / 2,
        impliedEndPadding:
          candidate.stage === 'complete' && encoderPrime.status === 0 && padding >= 0 ? padding : null,
        signalMatches:
          candidate.stage === 'complete' &&
          candidate.decodedFrames >= inputFrames &&
          signal.every(({ peak, toneAmplitude }) => peak > 0.25 && toneAmplitude > 0.1)
      })
    )
  }
  if (encoded.length) {
    const chrome = await decodeNativePackets(encoded)
    for (const { name } of encoded) {
      assert.ok(chrome[name], `Missing Chrome decoder outcome for ${name}`)
      console.log(JSON.stringify({ nativeAudio: 'chrome', name, ...chrome[name] }))
    }
  }
  console.log(JSON.stringify({ nativeAudio: 'complete' }))
}

if (import.meta.main) await main(process.argv[2])
