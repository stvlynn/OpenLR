// Catalog rules shared by the GUI dispatcher; no DOM or persistence dependencies.
import { processingVersion } from './process-version.js'

export function matchesCatalogFilters(photo, { rating, flag, edited }) {
  return (
    photo.rating >= rating &&
    (flag === 'any' || photo.flag === (flag === 'unflagged' ? '' : flag)) &&
    (edited === 'any' ||
      Object.entries(photo.edit).some(
        ([key, value]) =>
          key !== 'processVersion' && value !== 0 && value !== false && value !== '' && value !== null
      ) ===
        (edited === 'yes'))
  )
}

export class Organization {
  selection = new Set()
  explicit = false
  anchor = ''
  filters = { rating: 0, flag: 'any', edited: 'any' }
  direction = 'desc'
  clipboard = null

  matches(photo) {
    return matchesCatalogFilters(photo, this.filters)
  }
  compare(a, b, order) {
    let result
    if (order === 'name') result = a.name.localeCompare(b.name, undefined, { numeric: true })
    else if (order === 'rating') result = a.rating - b.rating
    else if (order === 'capture')
      result =
        (Date.parse(a.metadata?.DateTimeOriginal) || a.added) -
        (Date.parse(b.metadata?.DateTimeOriginal) || b.added)
    else if (order === 'focus') result = (a.review?.focus ?? -1) - (b.review?.focus ?? -1)
    else result = a.added - b.added
    return (this.direction === 'asc' ? 1 : -1) * result || a.id.localeCompare(b.id)
  }
  reconcile(list, active) {
    const ids = new Set(list.map((p) => p.id))
    this.selection = new Set([...this.selection].filter((id) => ids.has(id)))
    if (!this.explicit && !this.selection.size && list.length)
      this.selection.add(ids.has(active) ? active : list[0].id)
    return this.selection.has(active) ? active : [...this.selection][0] || ''
  }
  resetSelection() {
    this.selection.clear()
    this.explicit = false
    this.anchor = ''
  }
  choose(list, active, { id, toggle = false, range = false }) {
    const ids = list.map((p) => p.id)
    if (!ids.includes(id)) throw new Error('Photo is outside this view')
    this.explicit = true
    if (range) {
      const start = ids.indexOf(this.anchor || active),
        end = ids.indexOf(id)
      const span = ids.slice(Math.min(start < 0 ? end : start, end), Math.max(start, end) + 1)
      this.selection = new Set(toggle ? [...this.selection, ...span] : span)
    } else {
      if (toggle) {
        if (this.selection.has(id)) this.selection.delete(id)
        else this.selection.add(id)
      } else this.selection = new Set([id])
      this.anchor = id
    }
    return this.selection.has(id) ? id : [...this.selection][0] || ''
  }
  chooseMany(list, ids) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !list.some((p) => p.id === id)))
      throw new Error('Every selection ID must be in the current view')
    this.explicit = true
    this.selection = new Set(ids)
    this.anchor = ids[0] || ''
    return this.anchor
  }
  targets(photos) {
    return photos.filter((p) => this.selection.has(p.id))
  }
  setFilters(args) {
    const next = { ...this.filters, ...args }
    if (
      !Number.isInteger(next.rating) ||
      next.rating < 0 ||
      next.rating > 5 ||
      !['any', 'pick', 'reject', 'unflagged'].includes(next.flag) ||
      !['any', 'yes', 'no'].includes(next.edited)
    )
      throw new Error('Invalid catalog filter')
    this.filters = next
    this.resetSelection()
  }
  copy(photo, keys) {
    if (keys !== undefined && (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')))
      throw new Error('Edit keys must be an array of names')
    processingVersion(photo.edit)
    this.clipboard = { source: photo.id, edit: structuredClone(photo.edit), keys: keys ?? null }
    return { source: photo.id, keys: this.clipboard.keys, copied: true }
  }
  pasted(photo) {
    if (!this.clipboard) throw new Error('Copy edits from a photo first')
    const { edit, keys } = this.clipboard
    processingVersion(edit)
    if (keys === null) return structuredClone(edit)
    const result = structuredClone(photo.edit)
    for (const key of keys) {
      if (Object.hasOwn(edit, key)) result[key] = structuredClone(edit[key])
      else delete result[key]
    }
    processingVersion(result)
    return result
  }
}

export function namedVersion(photo, name) {
  name = String(name ?? '').trim()
  if (!name) throw new Error('Enter a version name')
  processingVersion(photo.edit)
  return { id: crypto.randomUUID(), name, created: Date.now(), edit: structuredClone(photo.edit) }
}

export function findVersion(photo, id) {
  const version = photo.versions?.find((v) => v.id === id)
  if (!version) throw new Error('Version not found on the selected photo')
  processingVersion(version.edit)
  return version
}
