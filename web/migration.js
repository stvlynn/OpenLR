import * as db from './catalog.js'
import * as local from './local.js'
import { decodeFile } from './transfer.js'
import { decodeEditSource } from './edit-source.js'
import { photoPreviewVersions } from './decode.js'
import { processingVersion, PROCESS_MESSAGES } from './process-version.js'
import { isVideo, poster } from './video.js'
import { metadata } from './metadata.js'
import { renderPrepared as render, toBlob, controls } from './render.js'
import { CRS_FIELDS, readXmp } from './xmp.js'
import { scanCatalog, relativeResource } from './migration-core.js'
import { validCrop } from './geometry.js'

const ranges = Object.assign({}, ...Object.values(controls)),
  prefix = 'migration:'
let engine
const call = (name, ...args) => {
  if (!globalThis.mygo?.call)
    throw Error('Original references require the desktop app and an explicitly authorized folder')
  return globalThis.mygo.call('Local.' + name, ...args)
}
const sql = () =>
  (engine ??= import('./vendor/sqlite/sql.js').then(({ default: init }) =>
    init({ locateFile: () => new URL('./vendor/sqlite/sql-wasm.wasm', import.meta.url).href })
  ))
const get = async (id) => {
  const plan = await db.transaction('sync', 'readonly', (tx) => tx.objectStore('sync').get(id))
  if (!plan?.id?.startsWith(prefix)) throw Error('Migration plan not found')
  return plan
}
const save = (plan) => db.save('sync', plan)
export const original = (photo) => local.original({ ...photo, local: photo.reference })
export const chooseFolder = () => call('ChooseReferenceRoot')
export async function scan(catalog) {
  const file = catalog instanceof File ? catalog : decodeFile(catalog),
    plan = await scanCatalog(file, await sql())
  const previous = await db.transaction('sync', 'readonly', (tx) => tx.objectStore('sync').get(plan.id))
  plan.mappings = previous?.mappings ?? []
  await save(plan)
  return report(plan.id)
}
export async function mapRoot({ id, sourceRoot, root, prefix = '' }) {
  const plan = await get(id)
  if (!plan.roots.some((row) => row.id === sourceRoot))
    throw Error('Source root is not listed in this catalog')
  const chosen = root ? (await call('Folders')).find((row) => row.id === root) : await chooseFolder()
  if (!chosen) {
    if (root) throw Error('Folder is not authorized')
    return null
  }
  if (prefix) prefix = relativeResource(prefix)
  if (!chosen.id) throw Error('Folder is not authorized')
  plan.mappings = plan.mappings.filter((row) => row.sourceRoot !== sourceRoot)
  plan.mappings.push({ sourceRoot, root: chosen.id, prefix, targetPath: chosen.path })
  await save(plan)
  return inspect(id)
}
const sourceReference = (plan, photo) => {
  if (photo.error) return { status: 'incomplete', reason: photo.error }
  const mapping = plan.mappings.find((row) => row.sourceRoot === photo.sourceRoot)
  if (!mapping)
    return { status: 'unmapped', reason: 'Map this catalog root to an authorized originals folder' }
  try {
    return {
      reference: {
        root: mapping.root,
        relative: relativeResource((mapping.prefix ? mapping.prefix + '/' : '') + photo.relative)
      }
    }
  } catch (error) {
    return { status: 'incomplete', reason: error.message }
  }
}
export async function inspect(id) {
  const plan = await get(id),
    rows = []
  for (const photo of plan.photos) {
    const mapped = sourceReference(plan, photo),
      row = {
        id: photo.id,
        sourceId: photo.sourceId,
        name: photo.name,
        sourcePath: photo.sourcePath,
        ...mapped
      }
    if (mapped.reference) {
      try {
        const info = await call('ReferenceInfo', mapped.reference.root, mapped.reference.relative)
        row.reference = { ...mapped.reference, size: info.size, modified: info.modified }
        row.status = 'available'
      } catch (error) {
        row.status = 'missing'
        row.reason = error.message
      }
    }
    rows.push(row)
  }
  return {
    id,
    name: plan.name,
    kind: plan.kind,
    schemaVersion: plan.schemaVersion,
    sourceSha256: plan.sourceSha256,
    roots: plan.roots,
    mappings: plan.mappings,
    total: rows.length,
    originals: new Set(
      plan.photos.filter((row) => row.relative).map((row) => row.sourceRoot + ':' + row.relative)
    ).size,
    availableOriginals: new Set(
      rows
        .filter((row) => row.status === 'available')
        .map((row) => row.reference.root + ':' + row.reference.relative)
    ).size,
    available: rows.filter((row) => row.status === 'available').length,
    missing: rows.filter((row) => row.status === 'missing').length,
    unmapped: rows.filter((row) => row.status === 'unmapped').length,
    incomplete: rows.filter((row) => row.status === 'incomplete').length,
    albums: plan.albums,
    warnings: plan.warnings,
    photos: rows
  }
}
export async function report(id) {
  if (!id)
    return (await db.all('sync'))
      .filter((row) => row.id.startsWith(prefix))
      .map(({ id, name, kind, created, lastReport }) => ({ id, name, kind, created, lastReport }))
  const plan = await get(id)
  return {
    id: plan.id,
    name: plan.name,
    kind: plan.kind,
    schemaVersion: plan.schemaVersion,
    schemaPolicy: plan.schemaPolicy,
    sourceSha256: plan.sourceSha256,
    total: plan.photos.length,
    originals: new Set(
      plan.photos.filter((row) => row.relative).map((row) => row.sourceRoot + ':' + row.relative)
    ).size,
    incomplete: plan.photos.filter((row) => row.error).length,
    unmapped: plan.photos.filter(
      (row) => !row.error && !plan.mappings.some((mapping) => mapping.sourceRoot === row.sourceRoot)
    ).length,
    roots: plan.roots,
    mappings: plan.mappings,
    albums: plan.albums,
    warnings: plan.warnings,
    lastReport: plan.lastReport ?? null
  }
}
function changes(photo, warnings) {
  let edit = {}
  if (photo.xmp)
    try {
      edit = readXmp(photo.xmp).edit ?? {}
    } catch (error) {
      if (error.code === 'PROCESS_VERSION') throw error
      warnings.push('XMP: ' + error.message)
    }
  for (const [key, field] of Object.entries(CRS_FIELDS))
    if (typeof photo.develop?.[field] === 'number') {
      const value = photo.develop[field],
        [min, max] = ranges[key]
      if (value < min || value > max) warnings.push(field + ' outside the supported range; not applied')
      else edit[key] = value
    }
  const d = photo.develop ?? {}
  if (d.HasCrop === true) {
    const crop = { x: d.CropLeft, y: d.CropTop, w: d.CropRight - d.CropLeft, h: d.CropBottom - d.CropTop }
    if (validCrop(crop) && !d.CropAngle) edit.crop = crop
    else warnings.push('Unsupported or rotated catalog crop; not applied')
  }
  const supported = new Set([
    ...Object.values(CRS_FIELDS),
    'HasCrop',
    'CropLeft',
    'CropTop',
    'CropRight',
    'CropBottom',
    'ProcessVersion',
    'Version'
  ])
  const unsupported = Object.keys(d).filter((key) => !supported.has(key))
  if (unsupported.length) warnings.push('Unmapped develop fields: ' + unsupported.join(', '))
  return edit
}
export async function commit(id) {
  const plan = await get(id),
    checked = await inspect(id),
    checkedMap = new Map(checked.photos.map((row) => [row.id, row])),
    existing = new Map((await db.all('photos')).map((row) => [row.id, row])),
    existingAlbums = new Set((await db.all('albums')).map((row) => row.id))
  const result = {
    id,
    sourceSha256: plan.sourceSha256,
    total: plan.photos.length,
    originals: checked.originals,
    availableOriginals: checked.availableOriginals,
    imported: [],
    existing: [],
    relinked: [],
    missing: [],
    failed: [],
    warnings: plan.warnings,
    mode: 'referenced-originals'
  }
  for (const album of plan.albums)
    if (!existingAlbums.has(album.id))
      await db.save('albums', { id: album.id, name: album.name, migration: { id, sourceId: album.sourceId } })
  for (const source of plan.photos) {
    const checkedRow = checkedMap.get(source.id)
    if (existing.has(source.id)) {
      const photo = existing.get(source.id)
      if (
        checkedRow.status === 'available' &&
        (photo.reference?.root !== checkedRow.reference.root ||
          photo.reference?.relative !== checkedRow.reference.relative)
      ) {
        await db.save('photos', { ...photo, reference: checkedRow.reference })
        result.relinked.push({ id: photo.id, reference: checkedRow.reference })
      }
      result.existing.push({ id: source.id, name: source.name })
      continue
    }
    if (checkedRow.status !== 'available') {
      result.missing.push(checkedRow)
      continue
    }
    let image
    try {
      const file = (await original({ ...source, reference: checkedRow.reference })).file,
        warnings = [...source.warnings]
      let xmp = source.xmp
      if (source.sidecar) {
        try {
          xmp = await (
            await original({
              name: source.sidecar.split('/').at(-1),
              reference: { ...checkedRow.reference, relative: source.sidecar }
            })
          ).file.text()
        } catch (error) {
          warnings.push('Sidecar: ' + error.message)
        }
      }
      const edit = changes({ ...source, xmp }, warnings)
      if (isVideo(file) && processingVersion(edit) === 2) throw Error(PROCESS_MESSAGES.video)
      const media = isVideo(file) ? await poster(file) : null
      image = media?.bitmap ?? (await decodeEditSource(file, edit))
      const sidecar = xmp
        ? (() => {
            try {
              return readXmp(xmp)
            } catch {
              return {}
            }
          })()
        : {}
      const photo = {
        id: source.id,
        name: source.name,
        width: image.width,
        height: image.height,
        added: Date.now(),
        rating: source.rating ?? sidecar.rating ?? 0,
        flag: source.flag ?? sidecar.flag ?? '',
        keywords: source.keywords || sidecar.keywords || '',
        colorLabel: source.colorLabel || '',
        deleted: false,
        albums: source.albums,
        edit,
        mediaType: file.type,
        ...(source.originalId ? { originalId: source.originalId, virtual: true } : {}),
        ...(media ? { duration: media.duration } : {}),
        metadata: media ? {} : await metadata(file),
        reference: checkedRow.reference,
        migration: {
          id,
          kind: plan.kind,
          sourceId: source.sourceId,
          sourcePath: source.sourcePath,
          sourceSha256: plan.sourceSha256,
          masterImage: source.masterImage,
          copyName: source.copyName,
          orientation: source.orientation,
          captureTime: source.captureTime,
          warnings
        },
        thumbnail: await toBlob(await render(image, edit, 240)),
        ...photoPreviewVersions(file)
      }
      await db.save('photos', photo)
      existing.set(photo.id, photo)
      result.imported.push({ id: photo.id, name: photo.name, reference: photo.reference, warnings })
    } catch (error) {
      result.failed.push({
        id: source.id,
        name: source.name,
        sourcePath: source.sourcePath,
        error: error.message
      })
    } finally {
      image?.close()
    }
  }
  plan.lastReport = result
  await save(plan)
  return result
}
export async function scanApple(root) {
  const folders = await call('Folders'),
    chosen = folders.find((row) => row.id === root)
  if (!chosen) throw Error('Choose an explicitly exported originals folder first')
  const resources = await call('ExportedResources', root),
    sidecars = new Map(
      resources
        .filter((row) => /\.xmp$/i.test(row.relative))
        .map((row) => [row.relative.replace(/\.[^.]+$/, ''), row.relative])
    )
  const digest = async (value) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (v) =>
      v.toString(16).padStart(2, '0')
    ).join('')
  const namespace = 'apple-export:' + root,
    id = prefix + namespace,
    albums = new Map()
  const photos = await Promise.all(
    resources
      .filter((row) => !/\.xmp$/i.test(row.relative))
      .map(async (row) => {
        const relative = relativeResource(row.relative),
          parent = relative.split('/').slice(0, -1).join('/'),
          albumId = 'apple_album_' + (await digest(root + ':' + parent))
        if (parent) albums.set(albumId, { id: albumId, name: parent, sourceId: parent })
        return {
          id: 'apple_' + (await digest(root + ':' + relative)),
          sourceId: relative,
          name: row.name,
          relative,
          sourceRoot: root,
          sourcePath: chosen.path + '/' + relative,
          albums: parent ? [albumId] : [],
          sidecar: sidecars.get(relative.replace(/\.[^.]+$/, '')),
          develop: {},
          warnings: []
        }
      })
  )
  const plan = {
    id,
    kind: 'apple-export',
    name: 'Apple Photos exported originals · ' + chosen.name,
    namespace,
    created: Date.now(),
    roots: [{ id: root, path: chosen.path, name: chosen.name }],
    mappings: [{ sourceRoot: root, root, prefix: '', targetPath: chosen.path }],
    photos,
    albums: [...albums.values()],
    warnings: [
      {
        code: 'standard-export',
        message:
          'Explicit standard resource export folder, not PhotoKit or a private Photos database. Folder names become albums only if exported that way. Edits, favorites, hidden state, face data, Live Photo pairing and original album membership cannot be inferred.'
      }
    ]
  }
  await save(plan)
  return inspect(id)
}
