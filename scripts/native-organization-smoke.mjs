import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { makePng } from '../tests/fixtures/png.mjs'
import { withNativeWorkspace } from './native-workspace.mjs'

const [executable, mode] = process.argv.slice(2)
if (mode !== undefined && mode !== '--macos-default-store') throw Error('Unknown catalog smoke mode: ' + mode)
const macosDefaultStore = mode === '--macos-default-store'
if (macosDefaultStore && process.platform !== 'darwin') throw Error('The macOS default store requires macOS')
const persistent = macosDefaultStore || ['win32', 'linux'].includes(process.platform)
await withNativeWorkspace(
  executable,
  async ({ root, call, initial, restart, session, pid }) => {
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

    assert.deepEqual(initial.photos, [])
    assert.deepEqual(initial.albums, [])
    assert.deepEqual((await call('scope', '--id', 'trash')).photos, [])
    await call('scope', '--id', 'all')
    const builtIns = await call('presets')
    assert.ok(builtIns.length > 0)
    const defaultPreferences = { autoAdvance: false, filenames: true, extensions: true, shortcuts: true }
    const savedPreferences = { ...defaultPreferences, filenames: false }
    assert.deepEqual(await call('preferences'), defaultPreferences)

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
    const expectedIds = JSON.stringify([second, first])
    await call('rate', '--value', '3', '--expectedIds', expectedIds)
    await call('flag', '--value', 'pick', '--expectedIds', expectedIds)
    await assert.rejects(
      () => call('rate', '--value', '5', '--expectedIds', JSON.stringify([first])),
      /selection changed/i
    )
    await assert.rejects(
      () => call('flag', '--value', 'reject', '--expectedIds', JSON.stringify([first])),
      /selection changed/i
    )
    const guarded = await call('state')
    for (const id of [first, second]) {
      assert.equal(row(guarded, id).rating, 3)
      assert.equal(row(guarded, id).flag, 'pick')
    }
    await call('rate', '--value', '0')
    await call('flag', '--value', '')
    const keywords = 'Highland, Test ridge'
    const firstTime = '2024-06-12T15:30:00.000Z',
      secondTime = '2024-06-12T15:30:02.000Z'
    for (const args of [
      ['label', '--value', 'red'],
      ['keywords', '--value', 'wrong target'],
      ['capture-time', '--time', firstTime],
      ['delete'],
      ['restore'],
      ['paste-edits']
    ])
      await assert.rejects(
        () => call(...args, '--expectedIds', JSON.stringify([first])),
        /selection changed/i
      )
    await call('label', '--value', 'purple', '--expectedIds', expectedIds)
    await call('keywords', '--value', keywords, '--expectedIds', expectedIds)
    const batch = await call('capture-time', '--time', firstTime, '--expectedIds', expectedIds)
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
    await assert.rejects(
      () => call('rename', '--name', 'wrong.png', '--photoId', first),
      /selected photo changed/i
    )
    const renamed = await call('rename', '--name', 'ridge-renamed.png', '--photoId', second)
    assert.equal(row(renamed, second).name, 'ridge-renamed.png')
    assert.notEqual(row(renamed, separate).label, 'purple')
    assert.notEqual(row(renamed, separate).keywords, keywords)
    assert.deepEqual(photosIn(await call('search', '--text', 'test RIDGE')), [first, second])
    await call('search', '--text', '')
    assert.deepEqual(photosIn(await sortBy('capture')), [first, second, separate])

    const album = await call('album', '--name', 'Draft collection')
    const removedAlbum = await call('album', '--name', 'Temporary collection')
    await selectMany(first, second)
    await assert.rejects(
      () => call('membership', '--album', album.id, '--expectedIds', JSON.stringify([first])),
      /selection changed/i
    )
    await call('membership', '--album', album.id, '--expectedIds', expectedIds)
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
    assert.deepEqual(photosIn(await call('delete', '--expectedIds', expectedIds)), [separate])
    assert.deepEqual(photosIn(await call('scope', '--id', 'trash')), [first, second])
    await call('select-all')
    assert.deepEqual((await call('restore', '--expectedIds', expectedIds)).photos, [])
    const restored = await call('scope', '--id', album.id)
    assert.deepEqual(photosIn(restored), [first, second])
    for (const photo of restored.photos) assert.equal(photo.deleted, false)
    await call('scope', '--id', 'all')

    await select(first)
    const edit = { Exposure: 0.625 }
    await call('edit', '--key', 'Exposure', '--value', String(edit.Exposure))
    await assert.rejects(
      () => call('version-save', '--name', 'Wrong photo', '--photoId', second),
      /selected photo changed/i
    )
    const version = await call('version-save', '--name', 'Draft edit', '--photoId', first)
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
    await assert.rejects(() => call('stack', '--expectedIds', JSON.stringify([first])), /selection changed/i)
    await assert.rejects(() => call('stack', '--photoId', second), /selected photo changed/i)
    assert.deepEqual(
      await call('stack', '--expectedIds', JSON.stringify([second, first]), '--photoId', first),
      { groups: 1, photos: 2 }
    )
    const collapsed = await call('state')
    assert.deepEqual(photosIn(collapsed), [first, separate])
    for (const command of ['stack-toggle', 'stack-cover', 'unstack'])
      await assert.rejects(() => call(command, '--photoId', second), /selected photo changed/i)
    const stackId = checkStack(await call('stack-toggle', '--photoId', first), first, second)
    await select(second)
    assert.equal(checkStack(await call('stack-cover', '--photoId', second), second, first), stackId)
    const changedCover = await call('stack-toggle')
    assert.deepEqual(photosIn(changedCover), [second, separate])
    assert.deepEqual(changedCover.openStacks, [])
    const unstacked = await call('unstack', '--photoId', second)
    assert.deepEqual(photosIn(unstacked), [first, second, separate])
    for (const id of [first, second]) {
      assert.equal(row(unstacked, id).stackId, null)
      assert.equal(row(unstacked, id).stackCover, false)
    }
    await select(first)
    await assert.rejects(
      () =>
        call(
          'auto-stack',
          '--by',
          'time',
          '--threshold',
          '3',
          '--expectedIds',
          JSON.stringify([first, second])
        ),
      /photos in this view changed/i
    )
    const timedStack = await call(
      'auto-stack',
      '--by',
      'time',
      '--threshold',
      '3',
      '--expectedIds',
      JSON.stringify([separate, second, first])
    )
    assert.deepEqual(timedStack, { groups: 1, photos: 2 })
    const timedId = checkStack(await call('stack-toggle'), first, second)

    if (persistent) {
      assert.deepEqual(await call('preferences', '--filenames', 'false'), savedPreferences)
      const reopened = await restart()
      const { pid: reopenedPID } = JSON.parse(await readFile(session, 'utf8'))
      assert.ok(Number.isSafeInteger(reopenedPID) && reopenedPID > 0 && reopenedPID !== pid)
      assert.deepEqual(await call('preferences'), savedPreferences)
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
    const similarStack = await call(
      'auto-stack',
      '--by',
      'similarity',
      '--threshold',
      '0.02',
      '--expectedIds',
      JSON.stringify([second, separate, first])
    )
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
        macosDefaultStore,
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
  },
  { persistent }
)
