// History stores changed catalog fields. The image asset remains owned by the catalog.
const tracked = new Set([
  'rate',
  'flag',
  'label',
  'keywords',
  'delete',
  'restore',
  'membership',
  'album',
  'album-rename',
  'album-rule',
  'album-delete',
  'stack',
  'stack-cover',
  'unstack',
  'auto-stack',
  'virtual-copy',
  'import',
  'save-frame',
  'merge-hdr',
  'merge-panorama',
  'version-save',
  'version-rename',
  'version-delete',
  'capture-time',
  'rename'
])
const fields = [
  'rating',
  'flag',
  'label',
  'keywords',
  'deleted',
  'albums',
  'versions',
  'stackId',
  'stackCover',
  'name',
  'metadata'
]
function changedFields(a, b) {
  const before = {},
    after = {}
  for (const key of fields) {
    if (a[key] === b[key]) continue
    before[key] = a[key]
    after[key] = b[key]
  }
  return Object.keys(before).length ? { id: a.id, before, after } : null
}
export class LibraryHistory {
  undo = []
  redo = []
  constructor(nextOrder) {
    let order = 0
    this.nextOrder = nextOrder ?? (() => ++order)
  }
  checkpoint(command, photos, albums, local) {
    if (!tracked.has(command) || local) return null
    return { photos: new Map(photos.map((p) => [p.id, p])), albums: new Map(albums.map((a) => [a.id, a])) }
  }
  record(previous, photos, albums) {
    if (!previous) return
    const rows = []
    for (const p of photos) {
      const old = previous.photos.get(p.id)
      if (old === p) continue
      const patch = old
        ? changedFields(old, p)
        : { id: p.id, before: { deleted: true }, after: { deleted: false } }
      if (patch) rows.push(patch)
    }
    const albumChanges = [],
      current = new Map(albums.map((a) => [a.id, a]))
    for (const id of new Set([...current.keys(), ...previous.albums.keys()])) {
      const old = previous.albums.get(id),
        next = current.get(id)
      if (old !== next) albumChanges.push({ id, before: old, after: next })
    }
    if (rows.length || albumChanges.length) {
      this.undo.push({ rows, albums: albumChanges, order: this.nextOrder() })
      this.redo.length = 0
    }
  }
  async replay(backwards, apply) {
    const [from, to] = backwards ? [this.undo, this.redo] : [this.redo, this.undo]
    const step = from.at(-1)
    if (!step) return false
    await apply(step, backwards ? 'before' : 'after')
    to.push({ ...from.pop(), order: this.nextOrder() })
    return true
  }
  clear() {
    this.undo.length = this.redo.length = 0
  }
}
