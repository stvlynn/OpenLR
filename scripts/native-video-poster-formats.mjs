import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const [control, candidate, directory] = process.argv.slice(2)
if (!control || !candidate || !directory)
  throw Error('Pass both packaged applications and the report directory')
const destination = path.resolve(directory)
const ff = (tool, ...args) => execFileSync(tool, args, { stdio: ['ignore', 'pipe', 'inherit'] })
const variants = [
  ['vp9.webm', 'vp9', 'opus'],
  ['vp9-remux.webm', 'vp9', 'opus'],
  ['vp9-remux-709.webm', 'vp9', 'opus', true],
  ['vp9-709.webm', 'vp9', 'opus', true]
]
await mkdir(destination, { recursive: true })
const source = path.join(destination, 'vp9.webm')
const packets = (file) =>
  ff('ffprobe', '-v', 'error', '-show_entries', 'packet=stream_index,data', '-show_data', '-of', 'json', file)
const sourcePackets = packets(source)
for (const [name, options] of [
  ['vp9-remux.webm', []],
  ['vp9-remux-709.webm', ['-colorspace', 'bt709']]
]) {
  const target = path.join(destination, name)
  ff('ffmpeg', '-nostdin', '-y', '-v', 'error', '-i', source, '-map', '0', '-c', 'copy', ...options, target)
  assert.deepEqual(packets(target), sourcePackets, name + ' compressed video and audio packets')
}
const timing = (name) =>
  ff(
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'packet=stream_index,pts,dts,duration,flags',
    '-of',
    'json',
    path.join(destination, name)
  )
assert.deepEqual(timing('vp9-remux.webm'), timing('vp9-remux-709.webm'), 'remuxed packet timing')
const fixtures = variants.map(([name, expectedVideo, expectedAudio, tagged = false]) => {
  const file = path.join(destination, name)
  const { streams, format } = JSON.parse(
    ff('ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file)
  )
  assert.deepEqual(
    streams.map((stream) => stream.codec_name),
    [expectedVideo, expectedAudio]
  )
  assert.equal(streams[0].color_space ?? 'unspecified', tagged ? 'bt709' : 'unspecified')
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

async function verify(label, app, order) {
  const records = []
  await withNativeWorkspace(
    app,
    async ({ root, call, initial }) => {
      assert.deepEqual(initial.photos, [])
      for (const fixture of order) {
        const { name, file, codecs, duration, first, later, matrix } = fixture
        await call('view', '--mode', 'grid')
        await call('search', '--text', name)
        const baseline = readPng(
          await readFile((await call('screenshot', '--output', path.join(root, 'empty.png'), '--force')).path)
        )
        const started = performance.now()
        const imported = await call('import', file)
        const record = {
          name,
          codecs,
          matrix,
          duration,
          firstFrameOracle: first,
          accepted: imported.added.length === 1,
          importMs: Math.round(performance.now() - started)
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
          const preview = await call('preview', '--output', path.join(root, 'preview-' + name + '.png'))
          const display = readPng(await readFile(preview.path))
          const center = (Math.floor(display.height / 2) * display.width + Math.floor(display.width / 2)) * 4
          record.detailColor = Array.from(display.data.subarray(center, center + 3), (value) =>
            Math.round(value * 255)
          )
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
  sweeps: []
}
// Keep both arms balanced across run order and each source's position in a fresh workspace.
for (const [arm, app, start] of [
  ['control', control, 0],
  ['release-first', candidate, 0],
  ['release-first', candidate, 2],
  ['control', control, 2]
]) {
  for (let index = start; index < start + 2; index++) {
    const order = fixtures.slice(index).concat(fixtures.slice(0, index))
    const records = await verify(`${arm}-${index + 1}`, app, order)
    results.sweeps.push({ arm, index, records })
    await writeFile(path.join(destination, 'report.json'), JSON.stringify(results, null, 2))
  }
}
console.log(JSON.stringify(results))
for (const record of results.sweeps.flatMap(({ records }) => records)) {
  assert.equal(record.accepted, true, record.name + ' import compatibility')
  assert.deepEqual(record.size, [96, 64], record.name)
  assert.ok(Math.abs(record.catalogDuration - record.duration) < 0.06, record.name + ' duration')
  assert.ok(record.posterPixels >= 700, record.name + ' first frame thumbnail')
  assert.ok(record.laterColorPixels < 200, record.name + ' later frame in thumbnail')
  assert.ok(Math.abs(record.firstSeek - 0.25) < 0.03, record.name + ' native seek')
}
