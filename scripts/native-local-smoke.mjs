import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execute, parse } from '../cli/openlr.mjs'
import { makeDng } from '../tests/fixtures/dng.mjs'
import UTIF from '../web/vendor/codecs/utif.js'

const executable = process.argv[2]
if (!executable) throw Error('Pass the path to a built OpenLR executable')
const directory = await mkdtemp(path.join(tmpdir(), 'openlr-native-local-'))
const photos = path.join(directory, 'photos'),
  session = path.join(directory, 'agent.json'),
  registry = path.join(directory, 'folders.json')
await mkdir(photos)
await mkdir(path.join(photos, 'subfolder'))
const original = Buffer.from(makeDng()),
  image = path.join(photos, 'sensor #1.dng')
await writeFile(image, original)
const historical = path.join(photos, 'subfolder', 'historical.dng'),
  unsupported = path.join(photos, 'subfolder', 'unsupported.dng'),
  historicalSidecar = JSON.stringify({ version: 1, recipe: {} }),
  unsupportedSidecar = JSON.stringify({ version: 2, recipe: { edit: { processVersion: 99 } } })
await writeFile(historical, original)
await writeFile(historical + '.openlr.json', historicalSidecar)
await writeFile(unsupported, original)
await writeFile(unsupported + '.openlr.json', unsupportedSidecar)
// The harness grants only its generated fixture folder. It does not bypass the
// production chooser or grant access to a user's photographs.
await writeFile(registry, JSON.stringify([{ id: 'fixture-root', name: 'Local fixture', path: photos }]))
let host, exited
const launch = async () => {
  host = spawn(path.resolve(executable), [], {
    windowsHide: true,
    env: {
      ...process.env,
      OPENLR_AGENT_FILE: session,
      OPENLR_LOCAL_FILE: registry,
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview2'),
      XDG_CONFIG_HOME: directory,
      XDG_DATA_HOME: directory,
      XDG_CACHE_HOME: directory
    },
    stdio: 'inherit'
  })
  exited = new Promise((resolve) => host.once('exit', resolve))
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
}
const stop = async () => {
  if (host) {
    host.kill()
    await Promise.race([exited, delay(3000)])
    host = null
    await rm(session, { force: true })
  }
}
const call = (...args) => execute(parse([...args, '--session', session]))
const selected = async () => {
  const state = await call('state')
  return state.photos.find((photo) => photo.id === state.selected)
}
const sidecar = async () => JSON.parse(await readFile(image + '.openlr.json', 'utf8'))
try {
  await launch()
  assert.equal((await call('local-folders'))[0].id, 'fixture-root')
  const opened = await call('local-open', '--root', 'fixture-root')
  assert.equal(opened.photos, 1)
  assert.equal(opened.warnings.length, 0)
  assert.equal((await selected()).local.sidecarPresent, false)
  assert.deepEqual((await selected()).edit, {})
  await call('view', '--mode', 'detail')
  await call('processing', '--version', '2')
  await call('edit', '--key', 'Exposure', '--value', '.5')
  await call('edit', '--key', 'turn', '--value', '1')
  await call('rate', '--value', '4')
  const linearVersion = await call('version-save', '--name', 'Linear local edit')
  assert.equal((await sidecar()).version, 2)
  assert.equal((await sidecar()).recipe.edit.processVersion, 2)
  assert.equal((await sidecar()).recipe.edit.Exposure, 0.5)
  assert.equal((await sidecar()).recipe.rating, 4)
  assert.equal((await sidecar()).recipe.versions[0].edit.processVersion, 2)
  // A legacy current edit must still protect a saved linear recipe from clients
  // that recognize only envelope 1.
  await call('processing', '--version', '1')
  assert.equal((await sidecar()).version, 2)
  await call('version-restore', '--id', linearVersion.id)
  assert.deepEqual(await readFile(image), original)
  const preview = await call('preview', '--output', path.join(directory, 'preview.png'))
  const png = await readFile(preview.path)
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [96, 128])
  const exported = await call('export', '--format', 'original', '--output', path.join(directory, 'copy.dng'))
  assert.deepEqual(await readFile(exported.path), original)
  const tiff = await call('export', '--format', 'image/tiff', '--output', path.join(directory, 'linear.tiff'))
  const bytes = await readFile(tiff.path),
    buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ifd = UTIF.decode(buffer)[0]
  assert.deepEqual(ifd.t258, [16, 16, 16, 16])
  UTIF.decodeImage(buffer, ifd)
  assert.deepEqual([ifd.width, ifd.height], [96, 128])
  const view = new DataView(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength)
  assert.ok(
    Array.from({ length: ifd.data.byteLength / 2 }, (_, i) => view.getUint16(i * 2, true)).some(
      (sample) => sample % 257 !== 0
    ),
    'TIFF must retain precision beyond an expanded 8-bit image'
  )
  await call('reset')
  assert.deepEqual((await selected()).edit, { processVersion: 2 })
  assert.equal((await sidecar()).recipe.rating, 4)
  assert.equal((await sidecar()).recipe.versions[0].edit.processVersion, 2)
  await call('undo')
  const nested = await call('local-browse', '--relative', 'subfolder')
  assert.equal(nested.photos, 2)
  assert.equal(nested.warnings.length, 1)
  const nestedState = await call('state'),
    historicalPhoto = nestedState.photos.find((photo) => photo.name === 'historical.dng'),
    unsupportedPhoto = nestedState.photos.find((photo) => photo.name === 'unsupported.dng')
  assert.equal(historicalPhoto.local.sidecarPresent, true)
  assert.deepEqual(historicalPhoto.edit, {})
  assert.ok(unsupportedPhoto.local.sidecarError)
  await call('select', '--id', unsupportedPhoto.id)
  await assert.rejects(
    call('export', '--format', 'image/tiff', '--output', path.join(directory, 'unsupported.tiff')),
    /process version/i
  )
  await assert.rejects(call('rate', '--value', '5'), /sidecar|process version/i)
  assert.equal(await readFile(historical + '.openlr.json', 'utf8'), historicalSidecar)
  assert.equal(await readFile(unsupported + '.openlr.json', 'utf8'), unsupportedSidecar)
  assert.deepEqual(await readFile(historical), original)
  assert.deepEqual(await readFile(unsupported), original)
  assert.deepEqual(await readFile(image), original)
  await stop()
  await launch()
  await call('local-open', '--root', 'fixture-root')
  const reopened = await call('state')
  assert.equal(reopened.photos[0].rating, 4)
  assert.equal(reopened.photos[0].edit.turn, 1)
  assert.equal(reopened.photos[0].edit.processVersion, 2)
  assert.equal(reopened.photos[0].versions[0].edit.processVersion, 2)
  assert.equal(reopened.photos[0].local.sidecarPresent, true)
  assert.equal(reopened.local.root.id, 'fixture-root')
  await call('library')
  const library = await call('state')
  assert.equal(library.local, null)
  assert.equal(library.photos.length, 0)
  console.log(
    'Native Local passed fixture folder browsing, DNG read, process-2 sidecar edits and named versions, version-preserving reset, actual TIFF16 samples, unsupported-sidecar rejection, original preservation, preview/export, restart/reopen, historical-empty-sidecar presence, and zero catalog imports. Folder permission was seeded by the test harness; the system chooser was not automated.'
  )
} finally {
  await stop()
  await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
}
