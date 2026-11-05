import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execute, parse } from '../cli/openlr.mjs'
import { makePng } from '../tests/fixtures/png.mjs'
import { inspectNativeStartup } from './native-startup-diagnostics.mjs'

const executable = process.argv[2]
if (!executable) throw Error('Pass the path to a built OpenLR executable')
const temp = await realpath(tmpdir()),
  prefix = 'olr-o-'
const root = await mkdtemp(path.join(temp, prefix))
const session = path.join(root, 'agent.json')
// WebView2 allows a private persistent profile, so restarting the host can test catalog reload.
const persistent = process.platform === 'win32'
const call = (...args) => execute(parse([...args, '--session', session, '--timeout', '30']))
let host, exited
async function start() {
  const startedAt = performance.now()
  let launchError, sessionAt, requestAt
  // MyGo falls back to a shared single-instance socket when its runtime path is too long.
  const socket = path.join(root, `mygo-${process.getuid?.() ?? -1}-000000000000.sock`)
  assert.ok(Buffer.byteLength(socket) < 100, 'Use a shorter temporary directory for the private MyGo socket')
  const env = {
    ...process.env,
    OPENLR_EPHEMERAL: persistent ? '0' : '1',
    OPENLR_AGENT_FILE: session,
    OPENLR_LOCAL_FILE: path.join(root, 'folders.json'),
    OPENLR_EXTERNAL_FILE: path.join(root, 'external.json'),
    OPENLR_SHARE_FILE: path.join(root, 'sharing.json'),
    OPENLR_CAMERA_DIRECTORY: path.join(root, 'captures'),
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview2'),
    APPDATA: root,
    LOCALAPPDATA: root,
    XDG_CONFIG_HOME: root,
    XDG_DATA_HOME: root,
    XDG_CACHE_HOME: root,
    XDG_RUNTIME_DIR: root
  }
  // Keep connecting to the existing compositor when the original socket name was relative.
  const { WAYLAND_DISPLAY: display, XDG_RUNTIME_DIR: runtime } = process.env
  if (process.platform === 'linux' && runtime && display && !path.isAbsolute(display))
    env.WAYLAND_DISPLAY = path.join(runtime, display)
  host = spawn(path.resolve(executable), [], { env, stdio: 'inherit' })
  host.once('error', (error) => {
    launchError = error
  })
  exited = new Promise((resolve) => host.once('close', resolve))
  try {
    const deadline = Date.now() + 45000
    for (;;) {
      if (launchError) throw launchError
      if (host.exitCode !== null || host.signalCode) throw Error('Host exited before agent connected')
      try {
        await access(session)
        break
      } catch {}
      if (Date.now() > deadline) throw Error('No agent session after 45 seconds')
      await delay(120)
    }
    sessionAt = requestAt = performance.now()
    return await call('state')
  } catch (error) {
    try {
      const diagnostic = await inspectNativeStartup({ session, host, startedAt, sessionAt, requestAt })
      console.error('Native organization startup diagnostics: ' + JSON.stringify(diagnostic))
    } catch {
      console.error('Native organization startup diagnostics unavailable')
    }
    throw error
  }
}
async function stop() {
  if (!host) return
  host.kill()
  await Promise.race([
    exited,
    delay(5000, undefined, { ref: false }).then(() => {
      throw Error('Host did not exit')
    })
  ])
  host = null
  await rm(session, { force: true })
}

const select = (id) => call('select', '--id', id)
const selectMany = (...ids) => call('select-many', '--ids', JSON.stringify(ids))
const sortBy = (order) => call('sort', '--order', order, '--direction', 'asc')
const photosIn = (state) => state.photos.map((photo) => photo.id)
function row(state, id) {
  const photo = state.photos.find((photo) => photo.id === id)
  assert.ok(photo, `Expected visible photo ${id}`)
  return photo
}
function checkStack(state, cover, member) {
  const coverPhoto = row(state, cover),
    memberPhoto = row(state, member)
  assert.ok(coverPhoto.stackId)
  assert.equal(memberPhoto.stackId, coverPhoto.stackId)
  assert.equal(coverPhoto.stackCover, true)
  assert.equal(memberPhoto.stackCover, false)
  assert.deepEqual(state.openStacks, [coverPhoto.stackId])
  return coverPhoto.stackId
}

let primaryFailure = false
try {
  const initial = await start()
  assert.deepEqual(initial.photos, [])
  assert.deepEqual(initial.albums, [])
  assert.deepEqual((await call('scope', '--id', 'trash')).photos, [])
  await call('scope', '--id', 'all')
  const builtIns = await call('presets')
  assert.ok(builtIns.length > 0)

  const width = 24,
    height = 16
  const fixtures = [
    ['bracket2.png', [68, 80, 99]],
    ['bracket10.png', [70, 82, 101]],
    ['separate.png', [190, 100, 28]]
  ].map(([name, rgb]) => ({
    filename: path.join(root, name),
    bytes: Buffer.from(
      makePng({
        width,
        height,
        bits: 8,
        data: Array(width * height)
          .fill(rgb)
          .flat()
      })
    )
  }))
  for (const { filename, bytes } of fixtures) await writeFile(filename, bytes)
  const imported = await call('import', ...fixtures.map(({ filename }) => filename))
  assert.deepEqual(imported.failed, [])
  assert.equal(imported.added.length, fixtures.length)
  const [first, second, separate] = imported.added

  assert.deepEqual(photosIn(await sortBy('name')), [first, second, separate])
  assert.deepEqual(photosIn(await call('search', '--text', 'BRACKET')), [first, second])
  assert.deepEqual((await call('select-all')).selection, [first, second])
  const keywords = 'Highland, Test ridge'
  const firstTime = '2024-06-12T15:30:00.000Z',
    secondTime = '2024-06-12T15:30:02.000Z'
  await call('label', '--value', 'purple')
  await call('keywords', '--value', keywords)
  const batch = await call('capture-time', '--time', firstTime)
  for (const id of [first, second]) {
    assert.equal(row(batch, id).label, 'purple')
    assert.equal(row(batch, id).keywords, keywords)
    assert.equal(row(batch, id).metadata.DateTimeOriginal, firstTime)
  }
  const page = await call('photos', '--offset', '1', '--limit', '1')
  assert.deepEqual(page, {
    total: 2,
    offset: 1,
    photos: [{ id: second, name: 'bracket10.png', rating: 0, flag: '', width, height, keywords }]
  })
  assert.deepEqual(await call('photos', '--offset', '2', '--limit', '1'), {
    total: 2,
    offset: 2,
    photos: []
  })
  await call('search', '--text', '')
  await selectMany(first, second)
  assert.deepEqual((await call('select-inverse')).selection, [separate])
  await call('capture-time', '--time', '2024-06-12T15:31:00.000Z')
  await select(second)
  await call('capture-time', '--time', secondTime)
  const renamed = await call('rename', '--name', 'ridge-renamed.png')
  assert.equal(row(renamed, second).name, 'ridge-renamed.png')
  assert.notEqual(row(renamed, separate).label, 'purple')
  assert.notEqual(row(renamed, separate).keywords, keywords)
  assert.deepEqual(photosIn(await call('search', '--text', 'test RIDGE')), [first, second])
  await call('search', '--text', '')
  assert.deepEqual(photosIn(await sortBy('capture')), [first, second, separate])

  const album = await call('album', '--name', 'Draft collection')
  const removedAlbum = await call('album', '--name', 'Temporary collection')
  await selectMany(first, second)
  await call('membership', '--album', album.id)
  await call('membership', '--album', removedAlbum.id)
  const renamedAlbum = await call('album-rename', '--id', album.id, '--name', 'Ridge collection')
  const retainedAlbum = { ...album, name: 'Ridge collection' }
  assert.deepEqual(
    renamedAlbum.albums.find(({ id }) => id === album.id),
    retainedAlbum
  )
  assert.deepEqual(photosIn(await call('scope', '--id', removedAlbum.id)), [first, second])
  const albumDeleted = await call('album-delete', '--id', removedAlbum.id)
  assert.equal(albumDeleted.scope, 'all')
  assert.deepEqual(albumDeleted.albums, [retainedAlbum])
  for (const id of [first, second]) assert.deepEqual(row(albumDeleted, id).albums, [album.id])

  await selectMany(first, second)
  assert.deepEqual(photosIn(await call('delete')), [separate])
  assert.deepEqual(photosIn(await call('scope', '--id', 'trash')), [first, second])
  await call('select-all')
  assert.deepEqual((await call('restore')).photos, [])
  const restored = await call('scope', '--id', album.id)
  assert.deepEqual(photosIn(restored), [first, second])
  for (const photo of restored.photos) assert.equal(photo.deleted, false)
  await call('scope', '--id', 'all')

  await select(first)
  const edit = { Exposure: 0.625 }
  await call('edit', '--key', 'Exposure', '--value', String(edit.Exposure))
  const version = await call('version-save', '--name', 'Draft edit')
  const removedVersion = await call('version-save', '--name', 'Temporary edit')
  assert.deepEqual(version.edit, edit)
  const retainedVersion = { ...version, name: 'Ridge edit' }
  const versionRenamed = await call('version-rename', '--id', version.id, '--name', retainedVersion.name)
  assert.deepEqual(row(versionRenamed, first).versions, [retainedVersion, removedVersion])
  const versionDeleted = row(await call('version-delete', '--id', removedVersion.id), first)
  assert.deepEqual(versionDeleted.edit, edit)
  assert.deepEqual(versionDeleted.versions, [retainedVersion])

  const preset = await call('preset-save', '--name', 'Ridge preset')
  const removedPreset = await call('preset-save', '--name', 'Temporary preset')
  assert.deepEqual(preset, { id: preset.id, name: 'Ridge preset', edit })
  assert.deepEqual(await call('presets'), [...builtIns, preset, removedPreset])
  await call('preset-delete', '--id', removedPreset.id)
  assert.deepEqual(await call('presets'), [...builtIns, preset])

  await selectMany(first, second)
  assert.deepEqual(await call('stack'), { groups: 1, photos: 2 })
  const collapsed = await call('state')
  assert.deepEqual(photosIn(collapsed), [first, separate])
  const stackId = checkStack(await call('stack-toggle'), first, second)
  await select(second)
  assert.equal(checkStack(await call('stack-cover'), second, first), stackId)
  const changedCover = await call('stack-toggle')
  assert.deepEqual(photosIn(changedCover), [second, separate])
  assert.deepEqual(changedCover.openStacks, [])
  const unstacked = await call('unstack')
  assert.deepEqual(photosIn(unstacked), [first, second, separate])
  for (const id of [first, second]) {
    assert.equal(row(unstacked, id).stackId, null)
    assert.equal(row(unstacked, id).stackCover, false)
  }
  await select(first)
  const timedStack = await call('auto-stack', '--by', 'time', '--threshold', '3')
  assert.deepEqual(timedStack, { groups: 1, photos: 2 })
  const timedId = checkStack(await call('stack-toggle'), first, second)

  if (persistent) {
    await stop()
    const reopened = await start()
    assert.deepEqual(reopened.openStacks, [])
    assert.equal(row(reopened, first).stackId, timedId)
    assert.ok(!reopened.photos.some(({ id }) => id === second))
    assert.deepEqual(reopened.albums, [retainedAlbum])
    await select(first)
    assert.equal(checkStack(await call('stack-toggle'), first, second), timedId)
  }
  const saved = await call('state')
  for (const [id, time] of [
    [first, firstTime],
    [second, secondTime]
  ]) {
    const photo = row(saved, id)
    assert.equal(photo.label, 'purple')
    assert.equal(photo.keywords, keywords)
    assert.equal(photo.metadata.DateTimeOriginal, time)
    assert.equal(photo.deleted, false)
    assert.deepEqual(photo.albums, [album.id])
  }
  assert.equal(row(saved, second).name, 'ridge-renamed.png')
  assert.deepEqual(row(saved, first).versions, [retainedVersion])
  assert.deepEqual(row(saved, first).edit, edit)
  assert.deepEqual(await call('presets'), [...builtIns, preset])

  await select(first)
  assert.deepEqual((await call('unstack')).openStacks, [])
  await select(second)
  const sample = () => call('sample-color', '--x', '0.5', '--y', '0.5')
  const originalColor = await sample()
  assert.equal(originalColor.color, '#465265')
  const applied = await call('preset-apply', '--id', preset.id)
  assert.deepEqual(row(applied, second).edit, edit)
  const presetColor = await sample()
  assert.match(presetColor.color, /^#[0-9a-f]{6}$/i)
  assert.ok(parseInt(presetColor.color.slice(1, 3), 16) > parseInt(originalColor.color.slice(1, 3), 16))

  // Similarity compares current thumbnails. Apply the same edit to both bracket photos first.
  await select(first)
  const similarStack = await call('auto-stack', '--by', 'similarity', '--threshold', '0.02')
  assert.deepEqual(similarStack, { groups: 1, photos: 2 })
  const similarExpanded = await call('stack-toggle')
  checkStack(similarExpanded, first, second)
  assert.ok(!row(similarExpanded, separate).stackId)
  assert.deepEqual((await call('unstack')).openStacks, [])

  for (const [index, id] of imported.added.entries()) {
    const { filename, bytes } = fixtures[index]
    await select(id)
    const output = await call(
      'export',
      '--format',
      'original',
      '--output',
      path.join(root, `original-${index}.png`)
    )
    assert.deepEqual(await readFile(output.path), bytes)
    assert.deepEqual(await readFile(filename), bytes)
  }
  console.log(
    JSON.stringify({
      nativeOrganization: 'passed',
      persistentReload: persistent,
      filteredPage: { total: page.total, offset: page.offset, name: page.photos[0].name },
      renamedPhoto: row(saved, second).name,
      retainedAlbum: retainedAlbum.name,
      retainedVersion: retainedVersion.name,
      timedStack,
      similarStack,
      presetPixels: [originalColor.color, presetColor.color],
      preservedOriginals: fixtures.length
    })
  )
} catch (error) {
  primaryFailure = true
  throw error
} finally {
  const cleanupFailures = []
  try {
    await stop()
  } catch (error) {
    cleanupFailures.push(error)
  }
  try {
    const cleanup = await realpath(root)
    assert.equal(path.dirname(cleanup), temp)
    assert.ok(path.basename(cleanup).startsWith(prefix))
    await rm(cleanup, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
  } catch (error) {
    cleanupFailures.push(error)
  }
  if (cleanupFailures.length) {
    if (!primaryFailure) throw new AggregateError(cleanupFailures, 'Native organization cleanup failed')
    console.error(
      'Native organization cleanup failed',
      cleanupFailures.map(({ code, name }) => code ?? name)
    )
  }
}
