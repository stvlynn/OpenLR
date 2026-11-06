import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { serveWorkspace } from '../tests/browser-server.mjs'
import { makeVideoFixture, videoFixtureSize } from '../tests/fixtures/video.mjs'
import { readPng } from '../web/png.js'

const executable = process.argv[2]
if (!executable) throw Error('Pass a built video origin probe executable')

async function generatedVideo() {
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
function sanitize(report) {
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
  const elementStages = ['complete', 'media-load', 'media-duration', 'seek', 'draw']
  return {
    nativeVideoOrigin: 'complete',
    context: { ...capabilities, documentOrigin: context.documentOrigin },
    direct: reportCandidate(report.direct, [0, 2.35], elementStages),
    poster: reportCandidate(
      report.poster,
      [0],
      ['complete', 'media-load', 'media-duration', 'poster-bitmap', 'draw']
    ),
    anonymous: reportCandidate(report.anonymous, [0, 2.35], elementStages),
    decoded: reportCandidate(report.decoded, [0, 2.35], ['complete', 'demux', 'decode', 'draw'])
  }
}

const temp = await realpath(tmpdir()),
  prefix = 'olr-vp-',
  root = await mkdtemp(path.join(temp, prefix))
try {
  const fixture = path.join(root, 'fixture.webm'),
    report = path.join(root, 'report.json'),
    frontend = fileURLToPath(new URL('../web/', import.meta.url))
  await writeFile(fixture, await generatedVideo())
  const env = {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview2'),
    APPDATA: root,
    LOCALAPPDATA: root,
    XDG_CONFIG_HOME: root,
    XDG_DATA_HOME: root,
    XDG_CACHE_HOME: root,
    XDG_RUNTIME_DIR: root
  }
  const { WAYLAND_DISPLAY: display, XDG_RUNTIME_DIR: runtime } = process.env
  if (process.platform === 'linux' && runtime && display && !path.isAbsolute(display))
    env.WAYLAND_DISPLAY = path.join(runtime, display)
  try {
    await promisify(execFile)(path.resolve(executable), [frontend, fixture, report], { env, timeout: 75000 })
  } catch ({ code, killed }) {
    throw Error(killed ? 'Video origin probe timed out' : `Video origin probe host failed (${code})`)
  }
  console.log(JSON.stringify(sanitize(JSON.parse(await readFile(report, 'utf8')))))
} finally {
  const cleanup = await realpath(root)
  assert.equal(path.dirname(cleanup), temp)
  assert.ok(path.basename(cleanup).startsWith(prefix))
  await rm(cleanup, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
}
