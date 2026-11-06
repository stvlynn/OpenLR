import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execute, parse } from '../cli/openlr.mjs'
import { makeLrcat } from '../tests/fixtures/lrcat.mjs'
import { frame, png } from '../tests/fixtures/merge-scene.js'

const executable = process.argv[2]
if (!executable) throw Error('Pass the final built native OpenLR executable')
const root = await mkdtemp(path.join(tmpdir(), 'openlr-migration-')),
  session = path.join(root, 'agent.json'),
  originals = path.join(root, 'originals'),
  apple = path.join(root, 'apple-export'),
  config = path.join(root, 'folders.json')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const authorized = (directory) => ({
  id: sha(process.platform === 'win32' ? directory.toLowerCase() : directory).slice(0, 32),
  name: path.basename(directory),
  path: directory
})
await mkdir(path.join(originals, 'Album'), { recursive: true })
await mkdir(path.join(apple, 'Export album'), { recursive: true })
const image = png(frame(80, 60)),
  catalog = Buffer.from(await makeLrcat()),
  catalogPath = path.join(root, 'synthetic-only.lrcat')
await writeFile(catalogPath, catalog)
for (const filename of ['first.png', 'second.png'])
  await writeFile(path.join(originals, 'Album', filename), image)
await writeFile(path.join(apple, 'Export album', 'apple.png'), image)
await writeFile(
  path.join(apple, 'Export album', 'apple.xmp'),
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmp:Rating="5" photoshop:DateCreated="2018-04-02T11:12:13+02:00"/></rdf:RDF></x:xmpmeta>'
)
const folders = [authorized(originals), authorized(apple)]
await writeFile(config, JSON.stringify(folders))
const host = spawn(path.resolve(executable), [], {
  windowsHide: true,
  env: {
    ...process.env,
    OPENLR_AGENT_FILE: session,
    OPENLR_LOCAL_FILE: config,
    OPENLR_EXTERNAL_FILE: path.join(root, 'external.json'),
    OPENLR_CAMERA_DIRECTORY: path.join(root, 'captures'),
    OPENLR_SHARE_FILE: path.join(root, 'sharing.json'),
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview2'),
    XDG_CONFIG_HOME: root,
    XDG_DATA_HOME: root,
    XDG_CACHE_HOME: root
  },
  stdio: 'inherit'
})
const exited = new Promise((resolve) => host.once('exit', resolve)),
  call = (...args) => execute(parse([...args, '--session', session]))
try {
  const deadline = Date.now() + 45000
  for (;;) {
    try {
      await access(session)
      break
    } catch {}
    if (host.exitCode !== null) throw Error('Desktop exited')
    if (Date.now() > deadline) throw Error('No desktop session')
    await delay(120)
  }
  const scan = await call('migration-scan', '--catalog', catalogPath),
    id = scan.id
  assert.equal(scan.total, 5)
  assert.equal((await call('state')).photos.length, 0)
  const mapped = await call('migration-map', '--id', id, '--sourceRoot', '1', '--root', folders[0].id)
  assert.equal(mapped.available, 3)
  assert.equal(mapped.missing, 1)
  assert.equal(mapped.incomplete, 1)
  const first = await call('migration-commit', '--id', id)
  assert.equal(first.imported.length, 3)
  assert.equal(first.failed.length, 0)
  let state = await call('state'),
    photo = state.photos.find((photo) => photo.migration.sourceId === '201')
  assert.equal(photo.rating, 4)
  assert.equal(photo.edit.Exposure, 0.75)
  assert.equal(photo.reference.root, folders[0].id)
  await call('select', '--id', photo.id)
  await call('edit', '--key', 'Exposure', '--value', '1.1')
  const output = path.resolve('.workspace/native-final')
  await mkdir(output, { recursive: true })
  await call(
    'export',
    '--format',
    'original',
    '--output',
    path.join(output, 'migration-original.png'),
    '--force'
  )
  assert.deepEqual(await readFile(path.join(output, 'migration-original.png')), image)
  await writeFile(path.join(originals, 'Album', 'missing.png'), image)
  const retry = await call('migration-retry', '--id', id)
  assert.equal(retry.imported.length, 1)
  assert.equal(retry.existing.length, 3)
  state = await call('state')
  assert.equal(state.photos.find((row) => row.id === photo.id).edit.Exposure, 1.1)
  const appleScan = await call('migration-apple-scan', '--root', folders[1].id),
    appleResult = await call('migration-commit', '--id', appleScan.id)
  assert.equal(appleResult.imported.length, 1)
  state = await call('state')
  const applePhoto = state.photos.find((row) => row.name === 'apple.png')
  assert.equal(applePhoto.rating, 5)
  assert.equal(applePhoto.metadata.DateTimeOriginal, '2018-04-02T11:12:13+02:00')
  assert.deepEqual(await readFile(catalogPath), catalog)
  assert.deepEqual(await readFile(path.join(originals, 'Album', 'first.png')), image)
  await call('screenshot', '--output', path.join(output, 'migration-synthetic.png'), '--force')
  await writeFile(
    path.join(output, 'migration-report.json'),
    JSON.stringify(
      {
        fixture: 'explicit synthetic SQLite capability schema and generated PNGs',
        realAdobeCatalogValidated: false,
        privatePhotosLibraryRead: false,
        photoKitValidated: false,
        nativeReferenceProtocolValidated: true,
        sourceCatalogSha256: sha(catalog),
        originalSha256: sha(image),
        scan,
        mapped,
        first,
        retry,
        appleResult
      },
      null,
      2
    )
  )
  console.log(
    'Native migration passed: synthetic-only Classic schema, reviewed authorized references, native image stream/original export, missing retry, preserved edits, unchanged sources and explicit Apple standard-resource XMP. No private or genuine Adobe/Photos library was examined.'
  )
} finally {
  host.kill()
  await Promise.race([exited, delay(3000)])
  assert.equal(path.dirname(root), path.resolve(tmpdir()))
  assert.ok(path.basename(root).startsWith('openlr-migration-'))
  await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
}
