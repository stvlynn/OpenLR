import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execute, parse, watch } from '../cli/openlr.mjs'
import { makeDng } from '../tests/fixtures/dng.mjs'
import { png as fixturePng } from '../tests/fixtures/merge-scene.js'

const executable = process.argv[2]
if (!executable) throw Error('Pass the path to a built OpenLR executable')
const root = await mkdtemp(path.join(tmpdir(), 'openlr-native-'))
const session = path.join(root, 'agent.json')
const host = spawn(path.resolve(executable), [], {
  env: {
    ...process.env,
    OPENLR_EPHEMERAL: '1',
    OPENLR_AGENT_FILE: session,
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview2'),
    XDG_CONFIG_HOME: root,
    XDG_DATA_HOME: root,
    XDG_CACHE_HOME: root
  },
  stdio: 'inherit'
})
const exited = new Promise((resolve) => host.once('exit', (code, signal) => resolve({ code, signal })))
const call = (...args) => execute(parse([...args, '--session', session]))
try {
  const end = Date.now() + 45000
  for (;;) {
    if (host.exitCode !== null || host.signalCode) throw Error('Host exited before agent connected')
    try {
      await access(session)
      break
    } catch {}
    if (Date.now() > end) throw Error('No agent session after 45 seconds')
    await delay(120)
  }
  await call('state', '--summary', 'true', '--timeout', '30')
  const file = path.join(root, 'sensor.dng'),
    data = Buffer.from(makeDng())
  await writeFile(file, data)
  const launch = await call('import', file)
  assert.deepEqual(launch.failed, [])
  assert.equal(launch.added.length, 1)
  await call('view', '--mode', 'detail')
  await call('edit', '--key', 'Exposure', '--value', '.5')
  await call('edit', '--key', 'turn', '--value', '1')
  const { result: state, frame } = await call(
    'rate',
    '--value',
    '4',
    '--capture',
    path.join(root, 'workspace.png')
  )
  const screen = await readFile(frame.path)
  assert.equal(screen.subarray(1, 4).toString(), 'PNG')
  assert.ok(screen.readUInt32BE(16) > 128 && screen.readUInt32BE(20) > 96)
  assert.equal(state.photos.find((p) => p.id === launch.added[0]).rating, 4)
  const preview = await call('preview', '--output', path.join(root, 'preview.png'))
  const png = await readFile(preview.path)
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [96, 128])
  const exported = await call('export', '--format', 'original', '--output', path.join(root, 'original.dng'))
  assert.deepEqual(await readFile(exported.path), data)
  const revisions = []
  await watch({ session, count: 2, images: path.join(root, 'observed') }, async (update) => {
    assert.equal(update.result.selected, launch.added[0])
    const bytes = await readFile(update.frame.path)
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
    revisions.push(update.revision)
    if (revisions.length === 1) {
      await call('lens-profiles', '--query', 'PowerShot')
      await call('sample-color', '--x', '0.5', '--y', '0.5')
      await call('flag', '--value', 'pick')
    } else assert.equal(update.result.photo.flag, 'pick')
  })
  assert.equal(revisions[1], revisions[0] + 1)
  const committedCrop = { x: 0.125, y: 0.125, w: 0.5, h: 0.5 }
  await call('edit', '--key', 'crop', '--value', JSON.stringify(committedCrop))
  await call('crop-tool')
  const { cropDraft: initialCrop } = await call(
    'crop-drag',
    '--grip',
    'new',
    '--x1',
    '0.25',
    '--y1',
    '0.25',
    '--x2',
    '0.75',
    '--y2',
    '0.625'
  )
  assert.deepEqual(initialCrop, { x: 0.25, y: 0.25, w: 0.5, h: 0.375 })
  const beforeGuide = await call(
    'export',
    '--format',
    'image/png',
    '--output',
    path.join(root, 'before-guide.png')
  )
  const guide = await call(
    'crop-guide',
    '--type',
    'golden-spiral',
    '--orientation',
    '1',
    '--capture',
    path.join(root, 'crop-guide.png')
  )
  assert.deepEqual(guide.result.cropGuide, { type: 'golden-spiral', orientation: 1 })
  assert.equal((await readFile(guide.frame.path)).subarray(1, 4).toString(), 'PNG')
  const guideState = await call('state', '--summary', 'true')
  assert.deepEqual(guideState.cropGuide, guide.result.cropGuide)
  assert.deepEqual(guideState.cropDraft, initialCrop)
  const afterGuide = await call(
    'export',
    '--format',
    'image/png',
    '--output',
    path.join(root, 'after-guide.png')
  )
  assert.deepEqual(await readFile(afterGuide.path), await readFile(beforeGuide.path))
  const moved = await call('crop-nudge', '--dx', '1', '--dy', '0', '--capture', path.join(root, 'crop.png'))
  assert.ok(moved.result.cropDraft.x > initialCrop.x)
  assert.equal(moved.result.cropDraft.y, initialCrop.y)
  assert.equal((await readFile(moved.frame.path)).subarray(1, 4).toString(), 'PNG')
  await call('crop-cancel')
  const canceled = await call('state')
  assert.equal(canceled.cropDraft, null)
  assert.deepEqual(canceled.photos.find((p) => p.id === canceled.selected).edit.crop, committedCrop)
  const personPath = new URL('../tests/fixtures/ai/astronaut.png', import.meta.url)
  const { fileURLToPath } = await import('node:url')
  await call('import', fileURLToPath(personPath))
  const mask = await call('ai-mask', '--target', 'person')
  assert.ok(mask?.id || (await call('state')).photos.some((p) => p.edit?.localTools?.masks?.length))
  const { localSelection } = await call('state', '--summary', 'true')
  assert.ok(localSelection.id)
  await call('local-select', '--args', JSON.stringify({ id: '' }))
  const selectedMask = await call(
    'local-select',
    '--id',
    localSelection.id,
    '--capture',
    path.join(root, 'selected-mask.png')
  )
  assert.deepEqual(selectedMask.result, localSelection)
  assert.equal((await readFile(selectedMask.frame.path)).subarray(1, 4).toString(), 'PNG')
  const sample = await call('export', '--format', 'image/tiff', '--output', path.join(root, 'astronaut.tif'))
  assert.ok((await readFile(sample.path)).length > 100000)
  const objects = new Map()
  const dav = createServer(async (req, res) => {
    const stored = objects.get(req.url)
    if (req.method === 'GET') {
      if (!stored) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { ETag: stored.tag }).end(stored.bytes)
      return
    }
    if (req.method !== 'PUT') {
      res.writeHead(405).end()
      return
    }
    if (
      (req.headers['if-none-match'] === '*' && stored) ||
      (req.headers['if-match'] && req.headers['if-match'] !== stored?.tag)
    ) {
      res.writeHead(412).end()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    objects.set(req.url, { tag: '"' + crypto.randomUUID() + '"', bytes: Buffer.concat(chunks) })
    res.writeHead(201).end()
  })
  await new Promise((resolve) => dav.listen(0, '127.0.0.1', resolve))
  try {
    const endpoint = 'http://127.0.0.1:' + dav.address().port + '/library/'
    const synced = await call('sync', '--endpoint', endpoint)
    assert.equal(synced.synced, true)
    const manifest = JSON.parse(objects.get('/library/openlr-manifest.json').bytes)
    assert.equal(manifest.photos[launch.added[0]].flag, 'pick')
    assert.deepEqual(objects.get('/library/openlr-' + launch.added[0] + '.original').bytes, data)
    assert.equal((await call('sync', '--endpoint', endpoint)).uploaded, 0)
  } finally {
    dav.closeAllConnections()
    dav.close()
  }
  const colors = [
    [180, 60, 40],
    [45, 160, 70],
    [50, 70, 190],
    [128, 128, 128]
  ]
  const colorPixels = new Uint8ClampedArray(160 * 80 * 4)
  for (let y = 0; y < 80; y++)
    for (let x = 0; x < 160; x++) colorPixels.set([...colors[Math.floor(x / 40)], 255], (y * 160 + x) * 4)
  const colorSource = path.join(root, 'color-source.png')
  const colorBytes = fixturePng({ width: 160, height: 80, data: colorPixels })
  await writeFile(colorSource, colorBytes)
  const colorAsset = (await call('import', colorSource)).added[0]
  const colorResults = []
  for (const colorSpace of ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020']) {
    for (const [format, extension] of [
      ['image/png', 'png'],
      ['image/tiff', 'tif'],
      ['image/jpeg', 'jpg']
    ]) {
      await call('select', '--id', colorAsset)
      const file = await call(
        'export',
        '--format',
        format,
        '--colorSpace',
        colorSpace,
        '--quality',
        '1',
        '--output',
        path.join(root, `${colorSpace}.${extension}`)
      )
      if (colorSpace !== 'srgb' || format === 'image/tiff')
        assert.ok((await readFile(file.path)).includes(Buffer.from(format === 'image/png' ? 'iCCP' : 'acsp')))
      const imported = await call('import', file.path)
      assert.equal(imported.failed.length, 0)
      const errors = []
      for (let i = 0; i < colors.length; i++) {
        const { color } = await call('sample-color', '--x', String((i + 0.5) / 4), '--y', '0.5')
        colors[i].forEach((value, c) =>
          errors.push(Math.abs(parseInt(color.slice(c * 2 + 1, c * 2 + 3), 16) - value))
        )
      }
      const maximum = Math.max(...errors)
      assert.ok(maximum <= (format === 'image/jpeg' ? 5 : 3), `${colorSpace} ${format}: ${maximum}`)
      colorResults.push({ colorSpace, format, maximum })
    }
  }
  assert.deepEqual(await readFile(colorSource), colorBytes)
  console.log('Native color-managed export/import:', JSON.stringify(colorResults))
  console.log(
    'Native GUI/CLI passed RAW, editing, PNG preview, original bytes, live observation, workspace capture, person segmentation, TIFF export and WebDAV sync.'
  )
} finally {
  host.kill()
  await Promise.race([exited, delay(3000)])
  await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
}
