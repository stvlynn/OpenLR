import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execute, parse, watch } from '../cli/openlr.mjs'
import { makeDng } from '../tests/fixtures/dng.mjs'

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
    if (revisions.length === 1) await call('flag', '--value', 'pick')
    else assert.equal(update.result.photo.flag, 'pick')
  })
  assert.ok(revisions[1] > revisions[0])
  const personPath = new URL('../tests/fixtures/ai/astronaut.png', import.meta.url)
  const { fileURLToPath } = await import('node:url')
  await call('import', fileURLToPath(personPath))
  const mask = await call('ai-mask', '--target', 'person')
  assert.ok(mask?.id || (await call('state')).photos.some((p) => p.edit?.localTools?.masks?.length))
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
  console.log(
    'Native GUI/CLI passed RAW, editing, PNG preview, original bytes, live observation, workspace capture, person segmentation, TIFF export and WebDAV sync.'
  )
} finally {
  host.kill()
  await Promise.race([exited, delay(3000)])
  await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
}
