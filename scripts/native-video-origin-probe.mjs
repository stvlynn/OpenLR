import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveWorkspace } from '../tests/browser-server.mjs'
import { makeVideoFixture, videoFixtureSize } from '../tests/fixtures/video.mjs'
import { readPng } from '../web/png.js'

async function generatedVideo() {
  const { chromium } = await import('playwright-core')
  const server = await serveWorkspace()
  let browser
  try {
    browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
    const page = await browser.newPage()
    await page.route(server.url + '/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Video fixture generator</title>' })
    )
    await page.goto(server.url)
    return await makeVideoFixture(page)
  } finally {
    try {
      await browser?.close()
    } finally {
      server.close()
    }
  }
}

const errorNames = [
  'Error',
  'SecurityError',
  'NotAllowedError',
  'NotSupportedError',
  'InvalidStateError',
  'TypeError',
  'other'
]
function checkError(name) {
  assert.ok(errorNames.includes(name), 'Invalid or missing candidate error class')
  return { errorName: name }
}
function checkFrameOperation(operation, channel, decode) {
  assert.equal(Object.keys(operation).length, 1, 'Frame operation must have one outcome')
  if ('errorName' in operation) return checkError(operation.errorName)
  const pixel = decode(operation.value)
  assert.ok(
    Array.isArray(pixel) &&
      pixel.length === 4 &&
      pixel.every((value) => Number.isInteger(value) && value >= 0 && value <= 255),
    'Invalid frame pixel'
  )
  return {
    pixel,
    matchesFixture:
      pixel[3] === 255 &&
      pixel[channel] > 130 &&
      pixel.slice(0, 3).every((value, index) => index === channel || value < 100)
  }
}
function reportFrame(frame, time) {
  assert.equal(frame.time, time)
  assert.ok(frame.size.length === 2 && frame.size.every((value) => Number.isSafeInteger(value) && value >= 0))
  const channel = time === 0 ? 0 : 2
  return {
    time,
    size: frame.size,
    matchesFixtureSize: frame.size.every((value, index) => value === videoFixtureSize[index]),
    read: checkFrameOperation(frame.read, channel, (pixel) => pixel),
    encode: checkFrameOperation(frame.encode, channel, (value) => {
      assert.equal(typeof value, 'string', 'Missing serialized PNG')
      const { width, height, data } = readPng(Buffer.from(value, 'base64'))
      assert.deepEqual([width, height], frame.size, 'Serialized PNG dimensions')
      const offset = ((height >> 1) * width + (width >> 1)) * 4
      return Array.from(data.slice(offset, offset + 4), (sample) => Math.round(sample * 255))
    })
  }
}
function reportCandidate(candidate, times, stages) {
  const { stage, frames, errorName, blobOrigin, readyState, networkState, width, height, mediaErrorCode } =
    candidate
  assert.ok(stages.includes(stage), 'Invalid or missing candidate stage')
  assert.ok(Array.isArray(frames) && frames.length <= times.length, 'Invalid candidate frames')
  if (stage === 'complete') {
    assert.equal(errorName, undefined)
    assert.equal(frames.length, times.length, 'Candidate omitted frames')
  } else checkError(errorName)
  if (blobOrigin !== undefined) assert.ok(['same', 'opaque', 'different'].includes(blobOrigin))
  if (readyState !== undefined) {
    assert.ok(Number.isInteger(readyState) && readyState >= 0 && readyState <= 4)
    assert.ok(Number.isInteger(networkState) && networkState >= 0 && networkState <= 3)
    assert.ok([width, height].every((value) => Number.isSafeInteger(value) && value >= 0))
    assert.ok([null, 1, 2, 3, 4].includes(mediaErrorCode))
  }
  return {
    stage,
    errorName,
    blobOrigin,
    readyState,
    networkState,
    width,
    height,
    mediaErrorCode,
    frames: frames.map((frame, index) => reportFrame(frame, times[index]))
  }
}
const times = [0, 2.35]
const elementStages = ['complete', 'media-load', 'media-duration', 'seek', 'draw']
const candidates = {
  direct: { times, stages: elementStages },
  poster: {
    times: [0],
    stages: [
      'complete',
      'media-load',
      'media-duration',
      'frame-access',
      'frame-decode',
      'poster-bitmap',
      'draw'
    ]
  },
  anonymous: { times, stages: elementStages },
  decoded: { times, stages: ['complete', 'demux', 'decode', 'draw'] }
}

function sanitize(report, candidate) {
  assert.equal(report.candidate, candidate, 'Report belongs to a different candidate')
  const { context } = report
  const capabilities = {}
  for (const key of [
    'secureContext',
    'nativeScheme',
    'videoDecoder',
    'videoEncoder',
    'audioDecoder',
    'audioEncoder'
  ]) {
    assert.equal(typeof context[key], 'boolean', 'Missing renderer capability')
    capabilities[key] = context[key]
  }
  assert.ok(['opaque', 'tuple'].includes(context.documentOrigin), 'Missing renderer origin')
  const { times, stages } = candidates[candidate]
  return {
    nativeVideoOrigin: 'candidate',
    candidate,
    context: { ...capabilities, documentOrigin: context.documentOrigin },
    result: reportCandidate(report.result, times, stages)
  }
}

class ProbeHostUnconfirmedError extends Error {}

export async function runProbeHost(executable, args, { env, timeout = 75000 } = {}) {
  const child = spawn(executable, args, { env, stdio: ['ignore', 'inherit', 'inherit'] })
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    // MyGo handles SIGTERM as a normal quit and can exit successfully on Unix.
    child.kill('SIGKILL')
  }, timeout)
  let status
  try {
    status = await once(child, 'close')
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.unref()
      throw new ProbeHostUnconfirmedError('Video origin probe host exit was not confirmed', { cause: error })
    }
    throw error
  } finally {
    clearTimeout(deadline)
  }
  const [code, signal] = status
  if (timedOut) throw Error(`Video origin probe timed out after ${timeout}ms`)
  if (code !== 0) throw Error(`Video origin probe host failed (${code ?? signal})`)
}

async function removeDirectory(directory, parent, prefix) {
  const cleanup = await realpath(directory)
  assert.equal(path.dirname(cleanup), parent)
  assert.ok(path.basename(cleanup).startsWith(prefix))
  await rm(cleanup, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
}

function profileEnvironment(profile) {
  const env = {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(profile, 'webview2'),
    APPDATA: profile,
    LOCALAPPDATA: profile,
    XDG_CONFIG_HOME: profile,
    XDG_DATA_HOME: profile,
    XDG_CACHE_HOME: profile,
    XDG_RUNTIME_DIR: profile
  }
  const { WAYLAND_DISPLAY: display, XDG_RUNTIME_DIR: runtime } = process.env
  if (process.platform === 'linux' && runtime && display && !path.isAbsolute(display))
    env.WAYLAND_DISPLAY = path.join(runtime, display)
  return env
}

async function main(executable) {
  if (!executable) throw Error('Pass a built video origin probe executable')
  const temp = await realpath(tmpdir()),
    prefix = 'olr-vp-',
    root = await mkdtemp(path.join(temp, prefix))
  let retainRoot = false
  try {
    const fixture = path.join(root, 'fixture.webm'),
      frontend = fileURLToPath(new URL('../web/', import.meta.url))
    await writeFile(fixture, await generatedVideo())
    const deadline = performance.now() + 75000
    const failed = []
    for (const candidate of Object.keys(candidates)) {
      const profilePrefix = `${candidate}-`
      const profile = await mkdtemp(path.join(root, profilePrefix))
      try {
        const report = path.join(profile, 'report.json')
        const timeout = Math.min(15000, Math.floor(deadline - performance.now()))
        if (timeout <= 0) throw Error('Aggregate video origin probe deadline expired before launch')
        console.error(`Video origin probe candidate: ${candidate}`)
        await runProbeHost(path.resolve(executable), [frontend, fixture, report, candidate], {
          env: profileEnvironment(profile),
          timeout
        })
        const contents = await readFile(report, 'utf8').catch((error) => {
          if (error.code === 'ENOENT') throw Error('Video origin probe host exited without a report')
          throw error
        })
        console.log(JSON.stringify(sanitize(JSON.parse(contents), candidate)))
      } catch (error) {
        console.error(`Video origin probe ${candidate} incomplete: ${error.message}`)
        if (error instanceof ProbeHostUnconfirmedError) {
          retainRoot = true
          throw new Error(`Video origin probe ${candidate} could not be stopped`, { cause: error })
        }
        failed.push(new Error(`${candidate}: ${error.message}`, { cause: error }))
      } finally {
        if (!retainRoot) await removeDirectory(profile, root, profilePrefix)
      }
    }
    if (failed.length) throw new AggregateError(failed, 'Incomplete video origin probe candidates')
    console.log(JSON.stringify({ nativeVideoOrigin: 'complete' }))
  } finally {
    if (retainRoot)
      console.error(`Video origin probe retained its temporary directory ${path.basename(root)}`)
    else await removeDirectory(root, temp, prefix)
  }
}

if (import.meta.main) await main(process.argv[2])
