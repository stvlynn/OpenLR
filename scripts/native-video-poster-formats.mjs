import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const [control, candidate, directory] = process.argv.slice(2)
if (!control || !candidate || !directory) throw Error('Pass the two poster packages and report directory')
const destination = path.resolve(directory)
const ff = (tool, ...args) => execFileSync(tool, args, { stdio: ['ignore', 'pipe', 'inherit'] })
const variants = [
  ['vp8.webm', 'libvpx', 'libopus', 'vp8', 'opus'],
  ['vp9.webm', 'libvpx-vp9', 'libopus', 'vp9', 'opus'],
  ['h264.mp4', 'libx264', 'aac', 'h264', 'aac'],
  ['h264.mov', 'libx264', 'aac', 'h264', 'aac'],
  ['h264.mkv', 'libx264', 'aac', 'h264', 'aac'],
  ['vp9-709.webm', 'libvpx-vp9', 'libopus', 'vp9', 'opus', true],
  ['h264-709.mp4', 'libx264', 'aac', 'h264', 'aac', true]
]
await mkdir(destination, { recursive: true })
const fixtures = variants.map(([name, video, audio, expectedVideo, expectedAudio, tagged = false]) => {
  const file = path.join(destination, name)
  ff(
    'ffmpeg',
    '-v',
    'error',
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    "color=0xe03865:s=96x64:r=10:d=1.2,drawbox=color=0x2159db:t=fill:enable='gte(t,0.6)'",
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1.2',
    '-c:v',
    video,
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    audio,
    ...(tagged
      ? [
          '-vf',
          'scale=in_color_matrix=bt601:out_color_matrix=bt709',
          '-colorspace',
          'bt709',
          '-color_primaries',
          'bt709',
          '-color_trc',
          'bt709',
          '-color_range',
          'tv'
        ]
      : []),
    file
  )
  const { streams, format } = JSON.parse(
    ff('ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file)
  )
  assert.deepEqual(
    streams.map((stream) => stream.codec_name),
    [expectedVideo, expectedAudio]
  )
  if (tagged) assert.equal(streams[0].color_space, 'bt709')
  const pixelAt = (time) => [
    ...ff(
      'ffmpeg',
      '-v',
      'error',
      '-ss',
      time,
      '-i',
      file,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgba',
      '-f',
      'rawvideo',
      'pipe:1'
    ).subarray(0, 3)
  ]
  return {
    name,
    file,
    codecs: [expectedVideo, expectedAudio],
    matrix: streams[0].color_space ?? 'unspecified',
    duration: Number(format.duration),
    first: pixelAt('0'),
    later: pixelAt('0.7')
  }
})

function colorPatch({ data }, [expectedRed, expectedGreen, expectedBlue]) {
  let count = 0
  let red = 0,
    green = 0,
    blue = 0
  for (let at = 0; at < data.length; at += 4) {
    const r = data[at] * 255,
      g = data[at + 1] * 255,
      b = data[at + 2] * 255
    if (
      Math.abs(expectedRed - r) <= 32 &&
      Math.abs(expectedGreen - g) <= 32 &&
      Math.abs(expectedBlue - b) <= 32
    ) {
      count++
      red += r
      green += g
      blue += b
    }
  }
  return { count, pixel: count ? [red, green, blue].map((sum) => Math.round(sum / count)) : null }
}

async function verify(label, app) {
  const records = []
  await withNativeWorkspace(
    app,
    async ({ root, call, initial }) => {
      assert.deepEqual(initial.photos, [])
      for (const fixture of fixtures) {
        const { name, file, codecs, duration, first, later, matrix } = fixture
        await call('view', '--mode', 'grid')
        await call('search', '--text', name)
        const baseline = readPng(
          await readFile((await call('screenshot', '--output', path.join(root, 'empty.png'), '--force')).path)
        )
        const imported = await call('import', file)
        const record = {
          name,
          codecs,
          matrix,
          duration,
          firstFrameOracle: first,
          accepted: imported.added.length === 1
        }
        records.push(record)
        if (!record.accepted) {
          record.importErrors = imported.failed.map(({ error }) => error)
          continue
        }
        assert.deepEqual(imported.failed, [])
        const [id] = imported.added
        await call('search', '--text', name)
        await call('select', '--id', id)
        const photo = (await call('state')).photos.find((entry) => entry.id === id)
        assert.ok(photo)
        record.size = [photo.width, photo.height]
        record.catalogDuration = photo.duration
        const poster = path.join(destination, label + '-' + name + '.png')
        const deadline = Date.now() + 4000
        do {
          await call('screenshot', '--output', poster, '--force')
          const capture = readPng(await readFile(poster))
          const patch = colorPatch(capture, first)
          record.posterPixels = patch.count - colorPatch(baseline, first).count
          record.posterColor = patch.pixel
          record.laterColorPixels = colorPatch(capture, later).count - colorPatch(baseline, later).count
          if (record.posterPixels >= 700) break
          await delay(100)
        } while (Date.now() < deadline)

        const original = await call(
          'export',
          '--format',
          'original',
          '--output',
          path.join(root, 'original-' + name)
        )
        const bytes = await readFile(file)
        assert.deepEqual(await readFile(original.path), bytes)
        record.originalBytes = bytes.length
        try {
          const { playback } = await call('video-seek', '--time', '0.25')
          record.firstSeek = playback?.time
        } catch (error) {
          record.seekError = error.message
        }
      }
    },
    { env: { OPENLR_DIAGNOSTICS: '1' } }
  )
  return records
}

const results = {
  platform: process.platform,
  arch: process.arch,
  control: await verify('native', control),
  candidate: await verify('decoded', candidate)
}
await writeFile(path.join(destination, 'report.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results))
for (const [index, left] of results.control.entries()) {
  const right = results.candidate[index]
  if (left.name !== 'h264.mkv') assert.equal(left.accepted, true, left.name)
  assert.equal(right.accepted, left.accepted, left.name + ' import compatibility')
  if (!left.accepted) continue
  for (const record of [left, right]) {
    assert.deepEqual(record.size, [96, 64], record.name)
    assert.ok(Math.abs(record.catalogDuration - record.duration) < 0.06, record.name + ' duration')
    assert.ok(record.posterPixels >= 700, record.name + ' first frame thumbnail')
    assert.ok(record.laterColorPixels < 200, record.name + ' later frame in thumbnail')
    assert.ok(Math.abs(record.firstSeek - 0.25) < 0.03, record.name + ' native seek')
  }
}
