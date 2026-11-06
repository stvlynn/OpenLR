import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { makePng } from '../tests/fixtures/png.mjs'
import { readPng } from '../web/png.js'
import { startDavFixture } from './native-dav-fixture.mjs'
import { withNativeWorkspace } from './native-workspace.mjs'

const executable = process.argv[2]
if (!executable) throw Error('Pass the path to a built OpenLR executable')
if (process.platform !== 'win32') throw Error('The two-profile native sync smoke requires Windows WebView2')

const manifestPath = '/library/openlr-manifest.json'
const width = 32,
  height = 24,
  rgb = [72, 86, 112]
const bytes = Buffer.from(
  makePng({
    width,
    height,
    bits: 8,
    data: Array(width * height)
      .fill(rgb)
      .flat()
  })
)

function device({ call, root }) {
  let serial = 0
  const run = (command, args) => call(command, '--args', JSON.stringify(args))
  const save = async (format) => {
    const result = await call(
      'export',
      '--format',
      format,
      '--output',
      path.join(root, `image-${serial++}.png`)
    )
    return readFile(result.path)
  }
  return {
    run,
    state: () => call('state'),
    select: (id) => run('select', { id }),
    edit: (value) => run('edit', { key: 'Exposure', value }),
    rate: (value) => run('rate', { value }),
    original: () => save('original'),
    image: async () => readPng(await save('image/png')),
    // Always supply test-only values so the source CLI cannot read real DAV
    // credentials from the operator's environment.
    sync: (endpoint, prefer = '') =>
      run('sync', { endpoint, prefer, username: 'fixture', password: 'fixture' })
  }
}

function checkPhoto(state, id, { exposure, rating, flag = '' }) {
  const photo = state.photos.find((item) => item.id === id)
  assert.ok(photo)
  assert.deepEqual(photo.edit, { Exposure: exposure })
  assert.equal(photo.rating, rating)
  assert.equal(photo.flag, flag)
  return photo
}

function centerRgb(image) {
  assert.deepEqual([image.width, image.height], [width, height])
  const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
  return Array.from(image.data.subarray(offset, offset + 3), (value) => Math.round(value * 255))
}

let race
const dav = await startDavFixture({
  beforePut: async ({ path, ifMatch }) => {
    if (!race || path !== manifestPath || ifMatch !== race.tag) return
    const competing = race
    race = null
    // A second HTTP client publishes its edit while the native client's
    // conditional write is in flight. The server checks the native request
    // against the new tag only after this independent write commits.
    const response = await fetch(new URL('openlr-manifest.json', dav.endpoint), {
      method: 'PUT',
      headers: { 'If-Match': competing.tag },
      body: JSON.stringify(competing.manifest),
      signal: AbortSignal.timeout(5000)
    })
    await response.arrayBuffer()
    assert.equal(response.status, 201)
  }
})
const manifest = () => JSON.parse(dav.objects.get(manifestPath).bytes)
const snapshot = () => dav.objects.get(manifestPath)
try {
  await withNativeWorkspace(
    executable,
    async (a) => {
      const source = device(a)
      const file = path.join(a.root, 'dav-test.png')
      await writeFile(file, bytes)
      assert.deepEqual(a.initial.photos, [])
      const { added, failed } = await a.call('import', file)
      assert.deepEqual(failed, [])
      assert.equal(added.length, 1)
      const [id] = added
      const assetPath = `/library/openlr-${id}.original`
      await source.edit(0.5)
      await source.rate(2)
      const album = await source.run('album', { name: 'DAV test album' })
      await source.run('membership', { album: album.id })
      const preset = await source.run('preset-save', { name: 'DAV test preset' })
      const initialImage = await source.image()
      const initialPixel = centerRgb(initialImage)
      assert.ok(initialPixel.every((value, channel) => value > rgb[channel]))
      assert.deepEqual(await source.sync(dav.endpoint), {
        synced: true,
        uploaded: 1,
        updated: 0,
        conflicts: []
      })
      assert.deepEqual(
        dav.requests.map(({ method, path, status }) => [method, path, status]),
        [
          ['GET', manifestPath, 404],
          ['PUT', assetPath, 201],
          ['PUT', manifestPath, 201]
        ]
      )
      assert.deepEqual(
        dav.requests.slice(1).map(({ ifNoneMatch }) => ifNoneMatch),
        ['*', '*']
      )
      assert.deepEqual(dav.objects.get(assetPath).bytes, bytes)
      checkPhoto({ photos: Object.values(manifest().photos) }, id, { exposure: 0.5, rating: 2 })
      await a.stop()

      await withNativeWorkspace(
        executable,
        async (b) => {
          assert.notEqual(a.profile, b.profile)
          assert.deepEqual(b.initial.photos, [])
          const receiver = device(b)
          const receiveAt = dav.requests.length
          assert.deepEqual(await receiver.sync(dav.endpoint), {
            synced: true,
            uploaded: 0,
            updated: 1,
            conflicts: []
          })
          assert.deepEqual(
            dav.requests.slice(receiveAt).map(({ method, path, status }) => [method, path, status]),
            [
              ['GET', manifestPath, 200],
              ['GET', assetPath, 200]
            ]
          )
          const received = await receiver.state()
          assert.deepEqual(received.albums, [album])
          assert.deepEqual(checkPhoto(received, id, { exposure: 0.5, rating: 2 }).albums, [album.id])
          assert.deepEqual(
            (await b.call('presets')).find((item) => item.id === preset.id),
            preset
          )
          await receiver.select(id)
          assert.deepEqual(await receiver.original(), bytes)
          assert.deepEqual(await receiver.image(), initialImage)
          await receiver.rate(4)
          const initialTag = snapshot().tag
          assert.equal((await receiver.sync(dav.endpoint)).uploaded, 0)
          assert.equal(dav.requests.at(-1).ifMatch, initialTag)
          await b.stop()

          checkPhoto(await a.start(), id, { exposure: 0.5, rating: 2 })
          await source.select(id)
          await source.edit(1)
          assert.deepEqual(await source.sync(dav.endpoint), {
            synced: true,
            uploaded: 0,
            updated: 1,
            conflicts: []
          })
          checkPhoto(await source.state(), id, { exposure: 1, rating: 4 })
          const mergedImage = await source.image()
          const mergedPixel = centerRgb(mergedImage)
          assert.ok(mergedPixel.every((value, channel) => value > initialPixel[channel]))
          await a.stop()

          checkPhoto(await b.start(), id, { exposure: 0.5, rating: 4 })
          await receiver.select(id)
          await receiver.edit(-0.5)
          const beforeConflict = snapshot()
          const conflictAt = dav.requests.length
          const conflict = await receiver.sync(dav.endpoint)
          assert.deepEqual(conflict, {
            synced: false,
            conflicts: [{ store: 'photos', id, name: 'dav-test.png', fields: ['edit.Exposure'] }]
          })
          assert.equal(snapshot(), beforeConflict)
          assert.deepEqual(
            dav.requests.slice(conflictAt).map(({ method, status }) => [method, status]),
            [['GET', 200]]
          )
          checkPhoto(await receiver.state(), id, { exposure: -0.5, rating: 4 })
          const conflictPixel = centerRgb(await receiver.image())
          assert.ok(conflictPixel.every((value, channel) => value < rgb[channel]))
          assert.deepEqual(await receiver.sync(dav.endpoint, 'remote'), {
            synced: true,
            uploaded: 0,
            updated: 1,
            conflicts: conflict.conflicts
          })
          checkPhoto(await receiver.state(), id, { exposure: 1, rating: 4 })
          assert.deepEqual(await receiver.image(), mergedImage)
          await receiver.edit(1.5)
          const beforeRaceImage = await receiver.image()
          await b.stop()

          checkPhoto(await a.start(), id, { exposure: 1, rating: 4 })
          await source.select(id)
          await source.rate(5)
          assert.equal((await source.sync(dav.endpoint)).synced, true)
          await a.stop()

          checkPhoto(await b.start(), id, { exposure: 1.5, rating: 4 })
          await receiver.select(id)
          const beforeRace = snapshot()
          const competingManifest = manifest()
          competingManifest.photos[id].flag = 'pick'
          race = { tag: beforeRace.tag, manifest: competingManifest }
          const raceAt = dav.requests.length
          await assert.rejects(receiver.sync(dav.endpoint), /Another device just synced/)
          assert.equal(race, null)
          assert.notEqual(snapshot().tag, beforeRace.tag)
          assert.deepEqual(manifest(), competingManifest)
          const conditional = dav.requests.slice(raceAt).filter(({ method }) => method === 'PUT')
          assert.deepEqual(
            conditional.map(({ path, ifMatch, status }) => [path, ifMatch, status]),
            [
              [manifestPath, beforeRace.tag, 201],
              [manifestPath, beforeRace.tag, 412]
            ]
          )
          checkPhoto(await receiver.state(), id, { exposure: 1.5, rating: 4 })
          assert.deepEqual(await receiver.image(), beforeRaceImage)

          checkPhoto(await b.restart(), id, { exposure: 1.5, rating: 4 })
          await receiver.select(id)
          const winningTag = snapshot().tag
          assert.deepEqual(await receiver.sync(dav.endpoint), {
            synced: true,
            uploaded: 0,
            updated: 1,
            conflicts: []
          })
          assert.equal(dav.requests.at(-1).ifMatch, winningTag)
          checkPhoto(await receiver.state(), id, { exposure: 1.5, rating: 5, flag: 'pick' })
          assert.deepEqual(await receiver.original(), bytes)
          const converged = await receiver.image()
          assert.deepEqual(converged, beforeRaceImage)
          await b.stop()

          checkPhoto(await a.start(), id, { exposure: 1, rating: 5 })
          await source.select(id)
          assert.deepEqual(await source.sync(dav.endpoint), {
            synced: true,
            uploaded: 0,
            updated: 1,
            conflicts: []
          })
          checkPhoto(await source.state(), id, { exposure: 1.5, rating: 5, flag: 'pick' })
          assert.deepEqual(await source.image(), converged)
          assert.deepEqual(await source.original(), bytes)
          assert.deepEqual(await readFile(file), bytes)
          assert.deepEqual(dav.objects.get(assetPath).bytes, bytes)
          assert.deepEqual([...dav.objects.keys()], [assetPath, manifestPath])
          assert.equal(
            dav.requests.filter(({ method, path }) => method === 'PUT' && path === assetPath).length,
            1
          )
          console.log(
            JSON.stringify({
              nativeSync: 'passed',
              profiles: 'two private persistent Windows WebView2 profiles',
              receivedPixel: initialPixel,
              mergedPixel,
              conflictPixel,
              convergedPixel: centerRgb(converged),
              conflictFields: conflict.conflicts[0].fields,
              conditionalStatuses: conditional.map(({ status }) => status),
              originalBytes: bytes.length
            })
          )
        },
        { persistent: true }
      )
    },
    { persistent: true }
  )
} finally {
  await dav.close()
}
