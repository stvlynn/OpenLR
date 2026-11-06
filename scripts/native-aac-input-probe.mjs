import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { aacDecoderCookie } from '../web/audio-config.js'

const inputFrames = 9601
const packetFrames = 1024
const tones = [333, 777]
const pulseTimes = [0.145, 0.16]
const deadlineMs = 30_000

export async function chromeAacFixtures() {
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  let timer
  try {
    const page = await browser.newPage()
    const origin = 'https://openlr.test/'
    await page.route(origin, (route) => route.fulfill({ body: '<!doctype html>', contentType: 'text/html' }))
    await page.goto(origin)
    const evaluate = page.evaluate(
      async ({ inputFrames, packetFrames, tones, pulseTimes }) => {
        async function encodeAndDecode(sampleRate, channels) {
          const codec = 'mp4a.40.2'
          const config = {
            codec,
            sampleRate,
            numberOfChannels: channels,
            bitrate: 128000,
            aac: { format: 'aac' }
          }
          if (!(await AudioEncoder.isConfigSupported(config)).supported)
            throw Error('Chrome AAC encoder unavailable')
          const source = new Float32Array(inputFrames * channels)
          for (let frame = 0; frame < inputFrames; frame++) {
            const time = frame / sampleRate
            for (let channel = 0; channel < channels; channel++) {
              const toneWindow = Math.max(0, Math.min(1, (time - 0.025) / 0.01, (0.1 - time) / 0.01))
              const pulseDistance = (time - pulseTimes[channel]) / 0.00065
              source[frame * channels + channel] =
                0.22 * toneWindow * Math.sin(2 * Math.PI * tones[channel] * time) +
                0.7 * Math.exp(-0.5 * pulseDistance * pulseDistance)
            }
          }
          let description, failure
          const packets = []
          const encoder = new AudioEncoder({
            error: (error) => {
              failure = error
            },
            output(chunk, metadata) {
              if (metadata?.decoderConfig?.description) {
                description = Array.from(new Uint8Array(metadata.decoderConfig.description))
              }
              const data = new Uint8Array(chunk.byteLength)
              chunk.copyTo(data)
              packets.push(Array.from(data))
            }
          })
          const timestamp = (frame) => Math.round((frame * 1e6) / sampleRate)
          try {
            encoder.configure(config)
            const data = new AudioData({
              format: 'f32',
              sampleRate,
              numberOfChannels: channels,
              numberOfFrames: inputFrames,
              timestamp: 0,
              data: source
            })
            try {
              encoder.encode(data)
            } finally {
              data.close()
            }
            await encoder.flush()
            if (failure) throw failure
          } finally {
            if (encoder.state !== 'closed') encoder.close()
          }
          if (!description?.length || packets.length < 4 || packets.length > 32)
            throw Error('Incomplete Chrome AAC fixture')

          const decoderConfig = {
            codec,
            sampleRate,
            numberOfChannels: channels,
            description: Uint8Array.from(description)
          }
          if (!(await AudioDecoder.isConfigSupported(decoderConfig)).supported)
            throw Error('Chrome AAC decoder unavailable')
          const pcm = new Float32Array(packets.length * packetFrames * channels)
          let decodedFrames = 0
          const decoder = new AudioDecoder({
            error: (error) => {
              failure = error
            },
            output(audio) {
              try {
                if (
                  audio.sampleRate !== sampleRate ||
                  audio.numberOfChannels !== channels ||
                  Math.abs(audio.timestamp - timestamp(decodedFrames)) > 1
                ) {
                  throw Error('Chrome changed the raw AAC format or coded origin')
                }
                audio.copyTo(pcm.subarray(decodedFrames * channels), { format: 'f32', planeIndex: 0 })
                decodedFrames += audio.numberOfFrames
              } catch (error) {
                failure = error
              } finally {
                audio.close()
              }
            }
          })
          try {
            decoder.configure(decoderConfig)
            for (const [index, data] of packets.entries()) {
              const frame = index * packetFrames
              decoder.decode(
                new EncodedAudioChunk({
                  type: 'key',
                  timestamp: timestamp(frame),
                  duration: timestamp(frame + packetFrames) - timestamp(frame),
                  data: Uint8Array.from(data)
                })
              )
            }
            await decoder.flush()
            if (failure) throw failure
          } finally {
            if (decoder.state !== 'closed') decoder.close()
          }
          if (decodedFrames !== packets.length * packetFrames)
            throw Error('Chrome did not return every coded AAC frame')
          return { sampleRate, channels, description, packets, decodedFrames, pcm: Array.from(pcm) }
        }

        const fixtures = []
        for (const sampleRate of [44100, 48000]) {
          for (const channels of [1, 2]) {
            try {
              fixtures.push(await encodeAndDecode(sampleRate, channels))
            } catch (error) {
              throw Error(`Chrome AAC ${sampleRate} Hz, ${channels} channel(s): ${error.message}`)
            }
          }
        }
        return fixtures
      },
      { inputFrames, packetFrames, tones, pulseTimes }
    )
    return await Promise.race([
      evaluate,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Chrome AAC fixture deadline')), deadlineMs)
      })
    ])
  } finally {
    clearTimeout(timer)
    await browser.close()
  }
}

function decodeNativeFixture(executable, { sampleRate, channels, description, packets }) {
  const cookie = aacDecoderCookie(Uint8Array.from(description), { sampleRate, channels })
  const input = {
    sampleRate,
    channels,
    cookie: Buffer.from(cookie).toString('base64'),
    packets: packets.map((p) => Buffer.from(p).toString('base64'))
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      path.resolve(executable),
      ['--aac-input'],
      { timeout: 15000, maxBuffer: 512 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Error(error.killed ? 'Native AAC fixture deadline' : stderr.trim() || error.message, {
              cause: error
            })
          )
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch (error) {
          reject(error)
        }
      }
    )
    // The child callback reports the native failure if it exits before reading all of stdin.
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(input))
  })
}

function signalDetails(pcm, sampleRate, channels, channel) {
  const frames = pcm.length / channels
  const pulseStart = Math.floor(sampleRate * 0.125)
  let pulseFrame = pulseStart
  let peak = 0
  for (let frame = pulseStart; frame < frames; frame++) {
    const amplitude = Math.abs(pcm[frame * channels + channel])
    if (amplitude > peak) {
      peak = amplitude
      pulseFrame = frame
    }
  }
  const delay = pulseFrame - Math.round(pulseTimes[channel] * sampleRate)
  const start = Math.round(sampleRate * 0.04) + delay
  const end = Math.round(sampleRate * 0.09) + delay
  assert.ok(peak > 0.4 && start >= 0 && end <= frames, 'The decoded PCM must contain the known pulse')
  const amplitudes = tones.map((tone) => {
    let sine = 0,
      cosine = 0
    for (let frame = start; frame < end; frame++) {
      const sample = pcm[frame * channels + channel]
      const phase = (2 * Math.PI * tone * frame) / sampleRate
      sine += sample * Math.sin(phase)
      cosine += sample * Math.cos(phase)
    }
    return (2 * Math.hypot(sine, cosine)) / (end - start)
  })
  assert.ok(
    amplitudes[channel] > 0.15 && amplitudes[1 - channel] < 0.045,
    'The decoded PCM must preserve distinct channel tones'
  )
  return { peak, pulseFrame, tone: amplitudes[channel], otherTone: amplitudes[1 - channel] }
}

export function compareAacInput(fixture, native) {
  const { sampleRate, channels, decodedFrames, pcm: reference, packets } = fixture
  assert.equal(native.codedFrames, packets.length * packetFrames)
  assert.equal(native.decodedFrames, decodedFrames, 'Native AAC must return the full coded PCM')
  assert.ok(native.decodeChunks >= 2, 'The native decoder must resume after input underflow')
  const bytes = Buffer.from(native.pcm, 'base64')
  assert.equal(bytes.length, reference.length * 4)
  const pcm = Float32Array.from(reference, (_, i) => bytes.readFloatLE(i * 4))
  const channelResults = []
  for (let channel = 0; channel < channels; channel++) {
    const actual = signalDetails(pcm, sampleRate, channels, channel)
    const expected = signalDetails(reference, sampleRate, channels, channel)
    assert.ok(
      Math.abs(actual.pulseFrame - expected.pulseFrame) <= 2,
      'Native and Chrome pulse positions differ'
    )
    assert.ok(Math.abs(actual.tone - expected.tone) <= 0.015, 'Native and Chrome tone amplitudes differ')
    let zeroError = 0,
      power = 0
    for (let frame = 0; frame < decodedFrames; frame++) {
      const i = frame * channels + channel
      const error = pcm[i] - reference[i]
      zeroError += error * error
      power += reference[i] * reference[i]
    }
    const relativeRms = Math.sqrt(zeroError / power)
    assert.ok(
      relativeRms <= 0.035,
      `Native AAC raw waveform differs from Chrome in channel ${channel} (relative RMS ${relativeRms})`
    )
    let bestLag = 0,
      leastError = Infinity
    const lagLimit = 32
    for (let lag = -lagLimit; lag <= lagLimit; lag++) {
      let error = 0
      for (let frame = lagLimit; frame < decodedFrames - lagLimit; frame++) {
        const difference = pcm[frame * channels + channel] - reference[(frame + lag) * channels + channel]
        error += difference * difference
      }
      if (error < leastError) {
        leastError = error
        bestLag = lag
      }
    }
    assert.equal(bestLag, 0, 'Native and Chrome AAC must have the same raw PCM origin')
    channelResults.push({ ...actual, chromePulseFrame: expected.pulseFrame, relativeRms, bestLag })
  }
  return channelResults
}

async function main(executable) {
  if (!executable) throw Error('Pass a built Go audio-stream-probe executable')
  const fixtures = await chromeAacFixtures()
  for (const fixture of fixtures) {
    const { sampleRate, channels, description } = fixture
    try {
      const native = await decodeNativeFixture(executable, fixture)
      const signal = compareAacInput(fixture, native)
      console.log(
        JSON.stringify({
          nativeAacInput: 'passed',
          sampleRate,
          channels,
          description: Buffer.from(description).toString('hex'),
          codedFrames: native.codedFrames,
          decodedFrames: native.decodedFrames,
          decodeChunks: native.decodeChunks,
          signal
        })
      )
    } catch (error) {
      throw Error(`AAC input ${sampleRate} Hz, ${channels} channel(s): ${error.message}`, { cause: error })
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
