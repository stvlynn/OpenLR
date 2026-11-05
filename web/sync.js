import { validateColorGradingRecipe } from './color-grading.js'
import { encodeBlob } from './transfer.js'
import * as db from './catalog.js'
import { decodeEditSource } from './edit-source.js'
import { render, toBlob } from './render.js'
import { processingVersion } from './process-version.js'
import { validateToneCurveRecipe } from './tone-curves.js'
const stores = ['photos', 'albums', 'presets']
const stringify = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  )
const empty = () => ({ version: 1, photos: {}, albums: {}, presets: {} })
const map = (items) => Object.fromEntries(items.map((v) => [v.id, v]))
const same = (a, b) => stringify(a) === stringify(b)
function requiredManifestVersion(manifest) {
  let version = 1
  for (const store of ['photos', 'presets'])
    for (const row of Object.values(manifest[store])) {
      version = Math.max(version, processingVersion(row.edit))
      validateToneCurveRecipe(row.edit)
      validateColorGradingRecipe(row.edit)
      for (const snapshot of row.versions ?? []) {
        version = Math.max(version, processingVersion(snapshot.edit))
        validateToneCurveRecipe(snapshot.edit)
        validateColorGradingRecipe(snapshot.edit)
      }
    }
  return version
}
export function portablePhoto({ reference, local, thumbnail, migration, ...photo }) {
  if (migration) {
    const { sourcePath, warnings, ...provenance } = migration
    photo.migration = provenance
  }
  return photo
}
function combine(base, local, remote, path, conflicts, prefer) {
  if (same(local, remote) || same(base, remote)) return local
  if (same(base, local)) return remote
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  // A transition changes the meaning of every recipe value. Without a common
  // baseline in that process version, even disjoint fields cannot safely merge.
  if (
    path === 'edit' &&
    object(local) &&
    object(remote) &&
    (processingVersion(local) !== processingVersion(remote) ||
      processingVersion(base) !== processingVersion(local))
  ) {
    conflicts.push(path)
    return prefer === 'remote' ? remote : local
  }
  if (object(local) && object(remote) && (base === undefined || object(base))) {
    const merged = {}
    for (const key of new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(remote)])) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('Invalid remote field')
      const value = combine(
        base?.[key],
        local[key],
        remote[key],
        path ? path + '.' + key : key,
        conflicts,
        prefer
      )
      if (value !== undefined) merged[key] = value
    }
    return merged
  }
  conflicts.push(path || 'record')
  return prefer === 'remote' ? remote : local
}
export function reconcile(base, local, remote, prefer = '') {
  const next = empty(),
    conflicts = []
  for (const store of stores) {
    for (const id of new Set([
      ...Object.keys(base[store]),
      ...Object.keys(local[store]),
      ...Object.keys(remote[store])
    ])) {
      const before = base[store][id],
        here = local[store][id],
        there = remote[store][id]
      const fields = []
      let selected = combine(before, here, there, '', fields, prefer)
      if (fields.length) conflicts.push({ store, id, name: here?.name || there?.name || id, fields })
      if (!selected && store === 'photos' && (here || there)) selected = { ...(here || there), deleted: true }
      if (selected) next[store][id] = selected
    }
  }
  // The envelope is the compatibility gate old clients already enforce. Keep
  // it monotonic so an old client cannot resume writing a promoted library.
  next.version = Math.max(base.version, local.version, remote.version, requiredManifestVersion(next))
  return { next, conflicts }
}
function bytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
}
export function mountSync(run, report) {
  const dialog = document.getElementById('sync-dialog'),
    button = document.getElementById('sync-button'),
    form = dialog.querySelector('form')
  button.hidden = !globalThis.mygo?.call
  button.onclick = () => {
    form.elements.endpoint.value = localStorage.getItem('sync-url') || ''
    dialog.showModal()
  }
  form.onsubmit = async (e) => {
    e.preventDefault()
    if (e.submitter.value === 'cancel') {
      dialog.close()
      return
    }
    const args = Object.fromEntries(new FormData(form))
    e.submitter.disabled = true
    const output = form.querySelector('output')
    try {
      output.textContent = 'Syncing…'
      const result = await run('sync', args)
      localStorage.setItem('sync-url', args.endpoint)
      if (result.synced) {
        dialog.close()
        report('Library synced')
      } else {
        form.elements.prefer.closest('label').hidden = false
        output.textContent = 'Conflicting changes: ' + result.conflicts.map((c) => c.name).join(', ')
      }
    } catch (error) {
      output.textContent = error.message
    } finally {
      e.submitter.disabled = false
    }
  }
  dialog.onclose = () => {
    form.elements.password.value = ''
    form.elements.prefer.value = ''
    form.elements.prefer.closest('label').hidden = true
    form.querySelector('output').textContent = ''
  }
}
export async function synchronize(
  args,
  backend,
  readOriginal = (photo) => db.original(photo.originalId || photo.id)
) {
  const endpoint = new URL(args.endpoint)
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/'
  const key = endpoint.href
  const call = backend ?? ((method, ...args) => globalThis.mygo.call('Remote.' + method, ...args))
  await call('Connect', key, args.username || '', args.password || '')
  try {
    const stored = await db.transaction('sync', 'readonly', (tx) => tx.objectStore('sync').get(key))
    const base = stored?.manifest || empty(),
      local = empty()
    const records = await db.all('photos')
    const localRecords = map(records)
    local.photos = map(records.map(portablePhoto))
    local.albums = map(await db.all('albums'))
    local.presets = map(await db.all('presets'))
    local.version = requiredManifestVersion(local)
    const manifestName = 'openlr-manifest.json',
      response = await call('Get', manifestName)
    const remote =
      response.status === 404 ? empty() : JSON.parse(new TextDecoder().decode(bytes(response.data)))
    if (
      ![1, 2].includes(remote.version) ||
      stores.some((s) => !remote[s] || typeof remote[s] !== 'object' || Array.isArray(remote[s]))
    )
      throw Error('Unsupported remote catalog')
    for (const s of stores)
      for (const [id, row] of Object.entries(remote[s])) {
        if (
          !/^[a-z0-9_-]+$/i.test(id) ||
          ['__proto__', 'constructor', 'prototype'].includes(id) ||
          row.id !== id
        )
          throw Error('Invalid remote catalog record')
        if (s === 'photos' && (row.reference || row.local || row.migration?.sourcePath))
          throw Error('Remote catalog must not contain device-local original paths')
      }
    if (requiredManifestVersion(remote) > remote.version)
      throw Error('Remote catalog process version requires a newer manifest')
    const { next, conflicts } = reconcile(
      response.status === 404 ? empty() : base,
      local,
      remote,
      args.prefer
    )
    if (conflicts.length && !args.prefer) return { synced: false, conflicts }
    const uploads = new Set(),
      downloads = new Map(),
      changes = []
    for (const p of Object.values(next.photos)) {
      const assetId = p.originalId || p.id
      if (
        !remote.photos[p.id] &&
        !uploads.has(assetId) &&
        !Object.values(remote.photos).some((other) => (other.originalId || other.id) === assetId)
      ) {
        const original = await readOriginal(localRecords[p.id] ?? localRecords[assetId] ?? p)
        if (!original?.file) throw Error('Missing original for ' + p.name)
        for (const [suffix, blob] of [
          ['original', original.file],
          ['hdr', original.radiance]
        ]) {
          if (!blob) continue
          const put = await call(
            'Put',
            'openlr-' + (p.originalId || p.id) + '.' + suffix,
            '*',
            await encodeBlob(blob)
          )
          if (put.status !== 412 && !(put.status >= 200 && put.status < 300))
            throw Error('Could not upload ' + p.name)
        }
        uploads.add(assetId)
      }
      if (same(local.photos[p.id], p)) continue
      const localReference = localRecords[p.id]?.reference ?? localRecords[assetId]?.reference
      const storedOriginal =
        downloads.get(assetId) ??
        (await db.original(assetId)) ??
        (localReference ? await readOriginal(localRecords[p.id] ?? localRecords[assetId]) : null)
      let file = storedOriginal?.file,
        radiance = storedOriginal?.radiance
      if (!file) {
        const r = await call('Get', 'openlr-' + (p.originalId || p.id) + '.original')
        if (r.status !== 200) throw Error('Missing remote original for ' + p.name)
        file = new File([bytes(r.data)], p.name, { type: p.mediaType || '', lastModified: p.added })
        if (p.merge?.kind === 'hdr') {
          const h = await call('Get', 'openlr-' + (p.originalId || p.id) + '.hdr')
          if (h.status !== 200) throw Error('Missing remote HDR data')
          radiance = new Blob([bytes(h.data)], { type: 'image/vnd.radiance' })
        }
      }
      if (!storedOriginal) downloads.set(assetId, { id: assetId, file, ...(radiance ? { radiance } : {}) })
      const image = await decodeEditSource(file, p.edit)
      try {
        changes.push({
          photo: {
            ...p,
            ...(localReference ? { reference: localReference } : {}),
            ...(localRecords[p.id]?.migration ? { migration: localRecords[p.id].migration } : {}),
            thumbnail: await toBlob(render(image, p.edit, 240))
          },
          original: storedOriginal
            ? null
            : { id: p.originalId || p.id, file, ...(radiance ? { radiance } : {}) }
        })
      } finally {
        image.close()
      }
    }
    if (!same(remote, next)) {
      if (response.status !== 404 && (!response.etag || response.etag.startsWith('W/')))
        throw Error('WebDAV server must return a strong ETag to safely update this catalog')
      const result = await call(
        'Put',
        manifestName,
        response.status === 404 ? '*' : response.etag,
        await encodeBlob(new Blob([JSON.stringify(next)]))
      )
      if (result.status === 412)
        throw Error('Another device just synced. Run sync again to merge its changes.')
      if (result.status < 200 || result.status >= 300)
        throw Error('The WebDAV folder could not store the catalog.')
    }
    const writes = changes.flatMap(({ photo, original }) => (original ? [photo, original] : [photo]))
    await db.withMedia(writes, (packed, commit) =>
      commit([...stores, 'sync', 'originals'], 'readwrite', (tx) => {
        for (const s of stores) {
          const dest = tx.objectStore(s)
          for (const id of Object.keys(local[s]))
            if (!next[s][id]) {
              db.deleteRecord(tx, s, id)
              if (s === 'photos') db.deleteRecord(tx, 'originals', id)
            }
          if (s !== 'photos') for (const row of Object.values(next[s])) dest.put(row)
        }
        for (const row of packed) tx.objectStore(row.file ? 'originals' : 'photos').put(row)
        tx.objectStore('sync').put({ id: key, manifest: next })
      })
    )
    return { synced: true, uploaded: uploads.size, updated: changes.length, conflicts }
  } finally {
    await call('Disconnect')
  }
}
