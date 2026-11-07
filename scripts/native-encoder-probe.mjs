// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { runProbeHost, profileEnvironment } from './native-probe-host.mjs'
import { encoderCases, probeColors, encoderConfig } from './fixtures/encoder-probe/probe.js'
import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output
} from '../web/vendor/mediabunny/mediabunny.mjs'

export const encoderOrder = Object.freeze([
  ...Object.keys(encoderCases),
  ...Object.keys(encoderCases).toReversed()
])
const execute = promisify(execFile)
const tool = (name, tools) =>
  tools ? path.join(tools, name + (process.platform === 'win32' ? '.exe' : '')) : name

export async function verifyEncoderPackets(report, directory, tools) {
  assert.equal(report.candidate in encoderCases, true, 'Unknown candidate report')
  assert.deepEqual(report.requestedConfig, { ...encoderConfig, ...encoderCases[report.candidate] })
  assert.equal('framerate' in report.requestedConfig, false)
  assert.equal(report.output, report.chunks.length, 'Output callback count does not match retained chunks')
  if (!report.chunks.length) return { available: false, verified: false, reason: 'No encoded outputs' }
  const chunks = report.chunks
  assert.ok(
    chunks[0].decoderConfig?.descriptionBase64,
    'First AVC output omitted its actual decoder configuration'
  )
  const hydrateConfig = ({ descriptionBase64, ...fields }) => ({
    ...fields,
    description: new Uint8Array(Buffer.from(descriptionBase64, 'base64'))
  })
  const target = new BufferTarget(),
    source = new EncodedVideoPacketSource('avc')
  const output = new Output({ target, format: new Mp4OutputFormat() })
  output.addVideoTrack(source, { frameRate: 10 })
  await output.start()
  let missingChunkDurations = 0
  for (const [index, chunk] of chunks.entries()) {
    assert.ok(Number.isSafeInteger(chunk.timestamp) && chunk.timestamp >= 0 && chunk.timestamp % 100000 === 0)
    assert.ok(chunk.timestamp < 1500000)
    const data = new Uint8Array(Buffer.from(chunk.dataBase64, 'base64'))
    assert.equal(data.length, chunk.byteLength)
    if (chunk.duration == null) missingChunkDurations++
    await source.add(
      new EncodedPacket(data, chunk.type, chunk.timestamp / 1e6, (chunk.duration ?? 100000) / 1e6),
      chunk.decoderConfig ? { decoderConfig: hydrateConfig(chunk.decoderConfig) } : undefined
    )
    await writeFile(path.join(directory, `chunk-${String(index).padStart(2, '0')}.avc`), data)
  }
  source.close()
  await output.finalize()
  const mediaPath = path.join(directory, 'encoded.mp4')
  await writeFile(mediaPath, new Uint8Array(target.buffer))
  const options = { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 15000, windowsHide: true }
  const probe = await execute(
    tool('ffprobe', tools),
    ['-v', 'error', '-show_streams', '-show_frames', '-of', 'json', mediaPath],
    options
  )
  const metadata = JSON.parse(probe.stdout.toString())
  await writeFile(path.join(directory, 'ffprobe.json'), JSON.stringify(metadata, null, 2) + '\n')
  assert.deepEqual(
    metadata.streams.map(({ width, height, codec_name }) => [width, height, codec_name]),
    [[64, 96, 'h264']]
  )
  const decoded = await execute(
    tool('ffmpeg', tools),
    [
      '-v',
      'error',
      '-i',
      mediaPath,
      '-map',
      '0:v:0',
      '-fps_mode',
      'passthrough',
      '-pix_fmt',
      'rgba',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    options
  )
  assert.equal(decoded.stderr.length, 0, 'FFmpeg reported a decode error')
  const frameBytes = 64 * 96 * 4,
    count = decoded.stdout.length / frameBytes
  assert.ok(Number.isSafeInteger(count))
  assert.equal(count, chunks.length, 'Encoded outputs and independently decoded frames disagree')
  const timestamps = metadata.frames.map(({ best_effort_timestamp_time }) =>
    Math.round(Number(best_effort_timestamp_time) * 1e6)
  )
  assert.equal(timestamps.length, count)
  assert.deepEqual(
    timestamps,
    chunks.map(({ timestamp }) => timestamp).sort((a, b) => a - b)
  )
  const pixels = timestamps.map((timestamp, index) => {
    const expected = probeColors[Math.floor(timestamp / 500000)]
    const offset = index * frameBytes + ((96 >> 1) * 64 + (64 >> 1)) * 4
    const actual = [...decoded.stdout.subarray(offset, offset + 4)]
    assert.equal(actual[3], 255)
    assert.ok(
      expected.every((sample, channel) => Math.abs(sample - actual[channel]) <= 35),
      `Decoded frame ${index} colors differ`
    )
    return { timestamp, expected, actual }
  })
  await writeFile(path.join(directory, 'decoded.rgba'), decoded.stdout)
  const complete =
    report.outcome === 'complete' &&
    report.submitted === 15 &&
    report.output === 15 &&
    timestamps.every((timestamp, index) => timestamp === index * 100000)
  return {
    available: true,
    verified: complete,
    decodedFrames: count,
    pixels,
    missingChunkDurations,
    durationSource: 'Actual output chunk duration, or original 100000us input duration when output omits it',
    scope: 'Actual FFmpeg decode; hardware backend remains unobserved'
  }
}

export async function runEncoderComparison(outputDirectory, tools = process.env.OPENLR_FFMPEG_DIR) {
  const output = path.resolve(outputDirectory)
  const build = JSON.parse(await readFile(path.join(output, 'build.json'), 'utf8'))
  assert.equal(build.goos, 'darwin', 'This comparison requires an actual macOS binary')
  assert.equal(process.platform, 'darwin', 'Run on actual macOS')
  const destination = path.join(output, 'run')
  await mkdir(destination, { recursive: true })
  const temporary = await realpath(tmpdir()),
    trials = []
  const reportPath = path.join(destination, 'report.json')
  const report = async () => {
    const value = {
      build,
      order: encoderOrder,
      complete: trials.length === encoderOrder.length,
      verified: trials.length === encoderOrder.length && trials.every(({ verified }) => verified),
      trials,
      policyLimit:
        'Realtime may drop frames by specification; finishing alone is not an offline-export acceptance result'
    }
    await writeFile(reportPath, JSON.stringify(value, null, 2) + '\n')
    return value
  }
  for (const [index, candidate] of encoderOrder.entries()) {
    const directory = path.join(destination, `${index}-${candidate}`)
    await mkdir(directory)
    const profile = await mkdtemp(path.join(temporary, 'olr-ep-'))
    const trial = { index, candidate, verified: false, cleanupConfirmed: false }
    trials.push(trial)
    try {
      trial.ownership = await runProbeHost(
        path.join(output, build.executable),
        [directory, candidate, profile],
        {
          env: profileEnvironment(profile),
          timeout: 90000,
          recordDirectory: directory,
          ownGroup: true
        }
      )
      trial.cleanupConfirmed = trial.ownership.exitConfirmed
      const host = JSON.parse(await readFile(path.join(directory, 'host.json'), 'utf8'))
      assert.equal(host.pid, trial.ownership.pid, 'Report must belong to the freshly spawned host')
      const measurement = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'))
      assert.equal(measurement.candidate, candidate)
      trial.measurement = measurement
      trial.outputVerification = await verifyEncoderPackets(measurement, directory, tools)
      trial.verified = trial.outputVerification.verified
    } catch (error) {
      trial.ownership ??= error.ownership
      trial.cleanupConfirmed = trial.ownership?.exitConfirmed === true
      trial.error = { name: error.name, message: error.message }
    } finally {
      if (trial.cleanupConfirmed) {
        const cleanup = await realpath(profile)
        assert.equal(path.dirname(cleanup), temporary)
        assert.ok(path.basename(cleanup).startsWith('olr-ep-'))
        await rm(cleanup, { recursive: true, force: true })
      } else trial.retainedProfile = profile
      await report()
    }
    console.log(
      JSON.stringify({
        nativeEncoderProbe: 'case',
        index,
        candidate,
        outcome: trial.measurement?.outcome,
        verified: trial.verified,
        cleanupConfirmed: trial.cleanupConfirmed
      })
    )
    if (!trial.cleanupConfirmed) break
  }
  return report()
}

if (import.meta.main) {
  const result = await runEncoderComparison(process.argv[2] || 'build/native-encoder-probe', process.argv[3])
  if (!result.verified) process.exitCode = 1
}
