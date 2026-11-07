// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const revisions = Object.freeze({
  common: 'a8c07eea690a80238b64d111baf789c6898b71c9',
  baseline: 'ba16d3cec21711dfb01a410f1c8265e04b3e4376',
  candidate: '197e89b7f70a84bf71cb2753e8cb9d5dd9ec44be',
  harness: '9004d2318d2d00f6c5ff9bed70d6e80260319e82'
})
const root = fileURLToPath(new URL('..', import.meta.url))
function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true
  })
}
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, 'The pinned fixture source anchor must occur exactly once')
  return source.replace(before, after)
}

export function instrumentMain(source, preload) {
  return replaceOnce(
    source,
    '\t\tdesktop.startup.mark("window-requested")',
    '\t\tpage.PreloadScript += ' + JSON.stringify(preload) + '\n\t\tdesktop.startup.mark("window-requested")'
  )
}

function retainOutputs(source) {
  source = replaceOnce(
    source,
    "{ spawn } from 'node:child_process'",
    "{ execFileSync, spawn } from 'node:child_process'"
  )
  source = replaceOnce(
    source,
    '{ access, mkdtemp, readFile, realpath, rm }',
    '{ access, copyFile, mkdir, mkdtemp, readFile, realpath, rm }'
  )
  source = replaceOnce(source, 'return await workflow({', 'return await retainControlledOutputs(workflow, {')
  return (
    source +
    `
// Diagnostic fixture only: retain generated files before the existing owned cleanup.
async function retainControlledOutputs(workflow, context) {
  try {
    const result = await workflow(context)
    const preview = path.join(context.root, 'recovered-preview.png')
    await context.call('preview', '--output', preview)
    const pixel = (file) => [...execFileSync(process.env.OPENLR_INITIAL_DECODE_FFMPEG || 'ffmpeg', [
      '-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'
    ], { timeout: 20_000, windowsHide: true })]
    const previewPixel = pixel(preview)
    const videoPixel = pixel(path.join(context.root, 'trimmed.webm'))
    assert.ok(previewPixel.length === 4 && previewPixel[2] > 140 && previewPixel[2] > previewPixel[1] + 30 && previewPixel[1] > previewPixel[0] + 20 && previewPixel[3] === 255, 'Final AAC preview must contain the generated blue frame')
    assert.ok(videoPixel.length === 4 && videoPixel[0] > 110 && videoPixel[1] < 100 && videoPixel[2] < 100 && videoPixel[3] === 255, 'Recovered multitrack export must contain the generated red frame')
    console.log(JSON.stringify({ controlledInitialDecodeImage: 'passed', previewPixel, videoPixel }))
    return result
  } finally {
    const output = process.env.OPENLR_INITIAL_DECODE_OUTPUT
    if (!output) throw Error('The controlled fixture requires its owned output directory')
    await mkdir(output, { recursive: true })
    const retained = []
    for (const name of ['multitrack.webm', 'trimmed.webm', 'trimmed.mp4', 'aac-input.mp4', 'trimmed-44100.mp4', 'original-multitrack.webm', 'original-aac-input.mp4', 'recovered-preview.png']) {
      try {
        await copyFile(path.join(context.root, name), path.join(output, name))
        retained.push(name)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    console.log(JSON.stringify({ controlledInitialDecodeOutputs: retained }))
  }
}
`
  )
}

export async function prepareInitialDecodeComparison(destination) {
  const output = path.resolve(destination)
  await mkdir(output, { recursive: true })
  const staging = path.join(root, '.workspace')
  await mkdir(staging, { recursive: true })
  const source = await mkdtemp(path.join(staging, 'initial-decode-source-'))
  const archive = path.join(source, 'source.tar')
  git('archive', '--format=tar', '--output', archive, revisions.common)
  execFileSync('tar', ['-xf', archive, '-C', source], { timeout: 120_000, windowsHide: true })
  const preload = await readFile(
    new URL('./fixtures/initial-decode-recovery/preload.js', import.meta.url),
    'utf8'
  )
  const main = instrumentMain(await readFile(path.join(source, 'main.go'), 'utf8'), preload)
  await writeFile(path.join(source, 'main.go'), main)
  const helpers = [
    'native-audio-export-smoke.mjs',
    'native-video-trials.mjs',
    'native-audio-layout-comparison.mjs',
    'native-video-oracle.mjs',
    'native-workspace.mjs'
  ]
  const harness = {}
  for (const file of helpers) {
    const original = git('show', revisions.harness + ':scripts/' + file)
    const content = file === 'native-workspace.mjs' ? retainOutputs(original.toString()) : original
    await writeFile(path.join(source, 'scripts', file), content)
    harness[file] = { revision: revisions.harness, retainsOutputs: file === 'native-workspace.mjs' }
  }
  const fixture = git(
    'show',
    revisions.harness + ':scripts/fixtures/short-audio-layout/failed-multitrack.webm'
  )
  assert.equal(fixture.length, 59365)
  const fixturePath = path.join(output, 'original.webm')
  await writeFile(fixturePath, fixture)
  const videos = {}
  for (const label of ['baseline', 'candidate']) {
    const content = git('show', revisions[label] + ':web/video.js')
    await writeFile(path.join(output, label + '-video.js'), content)
    videos[label] = { revision: revisions[label] }
  }
  await writeFile(path.join(output, 'instrumented-main.go'), main)
  await writeFile(path.join(output, 'preload.js'), preload)
  const manifest = {
    revisions,
    videos,
    harness,
    fixture: { bytes: fixture.length },
    instrumentation: { preload: 'preload.js', main: 'instrumented-main.go' },
    scope:
      'Two direct stock Go native hosts from identical tracked common source, differing only in web/video.js. Temporary main.go preload and generated-output retention are diagnostic only; not ordinary package or spontaneous native codec recovery proof.'
  }
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { source, output, fixture: fixturePath, manifest }
}

export function initialDecodeOutcome(base, code, signal, log, label) {
  const records = log.split(/\r?\n/).flatMap((line) => {
    const prefix = 'OpenLR video import diagnostic: '
    const json = line.startsWith(prefix) ? line.slice(prefix.length) : line
    try {
      const record = JSON.parse(json)
      return record && typeof record === 'object' && !Array.isArray(record) ? [record] : []
    } catch {
      return []
    }
  })
  const controlled = records.filter(({ operation }) => operation === 'controlled-initial-decode')
  const injected = controlled.filter(({ stage }) => stage === 'injected')
  const release = controlled.filter(({ stage }) => stage === 'failed-player-released')
  const assignments = controlled.filter(({ stage }) => stage === 'source-assigned')
  const frames = controlled.filter(({ stage }) => stage === 'recovery-loadeddata')
  const retry = records.filter(
    ({ operation, stage }) => operation === 'trim' && stage === 'playback-load-retry'
  )
  const admission =
    injected.length === 1 &&
    injected[0].trusted === true &&
    injected[0].width === 96 &&
    injected[0].height === 64 &&
    injected[0].readyState >= 1 &&
    injected[0].mediaErrorCode === 3 &&
    injected[0].assignment === 2
  const cleanup =
    base.cleanupConfirmed &&
    base.oracleCleanupConfirmed &&
    !log.includes('Native workspace cleanup failed') &&
    !log.includes('Audio oracle cleanup failed:') &&
    release.length === 1 &&
    release[0].sourceRemoved === true &&
    release[0].readyState === 0
  const original = records.find(({ nativeAudioExport }) => nativeAudioExport === 'source-ready')
  const sourceVerified =
    original?.bytes === 59365 &&
    original.retained === true &&
    original.originalReadBeforeTrim === false &&
    base.beforeTrimChecks === 0
  const imageEvidence = records.find(
    ({ controlledInitialDecodeImage }) => controlledInitialDecodeImage === 'passed'
  )
  const baselineFailure =
    label === 'baseline' &&
    Number.isInteger(code) &&
    code > 0 &&
    signal === null &&
    !base.evidence &&
    base.exports.every((entry) => !entry) &&
    retry.length === 0 &&
    assignments.length === 2 &&
    frames.length === 0 &&
    log.includes('Controlled initial native decode failure')
  const recovered =
    label === 'candidate' &&
    code === 0 &&
    signal === null &&
    base.verified &&
    Boolean(imageEvidence) &&
    base.evidence.originalBytes === 59365 &&
    base.exports.slice(0, 2).every((entry) => entry.originalBytes === 59365) &&
    retry.length === 1 &&
    assignments.length === 3 &&
    assignments[2].sameOriginal === true &&
    frames.length === 1 &&
    frames[0].trusted === true &&
    frames[0].width === 96 &&
    frames[0].height === 64 &&
    frames[0].readyState >= 2
  return {
    ...base,
    controlled,
    imageEvidence,
    retryCount: retry.length,
    verified: Boolean(admission && cleanup && sourceVerified && (baselineFailure || recovered)),
    continueTrials: Boolean(base.continueTrials && cleanup)
  }
}

export async function runInitialDecodeComparison(destination, ffmpegBin) {
  assert.equal(process.platform, 'darwin', 'Controlled native acceptance requires actual macOS WKWebView')
  const prepared = await prepareInitialDecodeComparison(destination)
  const { source, output, fixture } = prepared
  const go = process.env.GO_BINARY || 'go'
  const toolchain = execFileSync(go, ['version'], { encoding: 'utf8', windowsHide: true }).trim()
  await writeFile(path.join(output, 'toolchain.log'), toolchain + '\n')
  const apps = {}
  for (const label of ['baseline', 'candidate']) {
    await writeFile(
      path.join(source, 'web', 'video.js'),
      await readFile(path.join(output, label + '-video.js'))
    )
    apps[label] = path.join(output, label)
    execFileSync(
      go,
      [
        'build',
        '-mod=vendor',
        '-tags',
        'mygo_noinspector',
        '-ldflags',
        '-X github.com/egoist/mygo.production=1',
        '-o',
        apps[label],
        '.'
      ],
      { cwd: source, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'inherit', timeout: 300_000 }
    )
  }
  const { runVideoTrials } = await import(pathToFileURL(path.join(source, 'scripts/native-video-trials.mjs')))
  const { audioLayoutOutcome } = await import(
    pathToFileURL(path.join(source, 'scripts/native-audio-layout-comparison.mjs'))
  )
  await runVideoTrials({
    apps,
    order: ['baseline', 'candidate'],
    destination: path.join(output, 'trials'),
    args: ffmpegBin ? [ffmpegBin] : [],
    environments: Object.fromEntries(
      ['baseline', 'candidate'].map((label) => [
        label,
        {
          OPENLR_AUDIO_SOURCE: fixture,
          OPENLR_AUDIO_ORIGINAL_BEFORE_TRIM: '0',
          OPENLR_INITIAL_DECODE_OUTPUT: path.join(output, label + '-outputs'),
          OPENLR_INITIAL_DECODE_FFMPEG: ffmpegBin ? path.join(path.resolve(ffmpegBin), 'ffmpeg') : 'ffmpeg'
        }
      ])
    ),
    script: path.join(source, 'scripts/native-audio-export-smoke.mjs'),
    sharedFixture: false,
    outcome: (code, signal, log, label) =>
      initialDecodeOutcome(audioLayoutOutcome(code, signal, log, 0), code, signal, log, label),
    metadata: prepared.manifest
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, ...options] = process.argv.slice(2)
  const prepareOnly = options.includes('--prepare-only')
  const ffmpeg = options.find((option) => option.startsWith('--ffmpeg-bin='))
  assert.ok(
    destination &&
      options.length <= 2 &&
      options.every((option) => option === '--prepare-only' || option.startsWith('--ffmpeg-bin=')),
    'Pass an output directory and optionally --prepare-only or --ffmpeg-bin=directory'
  )
  if (prepareOnly) console.log(JSON.stringify(await prepareInitialDecodeComparison(destination)))
  else await runInitialDecodeComparison(destination, ffmpeg?.slice('--ffmpeg-bin='.length))
}
