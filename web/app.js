import { importBatch } from './import-library.js'
import { validateArgs } from './agent-protocol.js'
import { decodeFile } from './transfer.js'
import { isVideo, openVideo, clipRange, exportVideo } from './video.js'
import { decodePhoto, PHOTO_ACCEPT } from './decode.js'
import { Presets } from './presets.js'
import { LibraryHistory } from './library-history.js'
import { preferences, setPreferences, mountPreferences, displayName, colorLabels } from './preferences.js'
import { displayedPhotos, findStacks, smartMatch, stackMenu } from './stacks.js'
import { exportXmp, readXmp, exportPackage } from './xmp.js'
import { mountSync, synchronize } from './sync.js'
import { metadata, describe } from './metadata.js'
import { readExportOptions, applyWatermark } from './export-options.js'
import * as db from './catalog.js'
import * as local from './local.js'
import * as external from './external.js'
import * as camera from './camera.js'
import * as sharing from './sharing.js'
import { geometry, validCrop } from './geometry.js'
import { CropSurface } from './crop-surface.js'
import { drawHistogram, histogram, autoExposure } from './histogram.js'
import { controls, render, toBlob } from './render.js'
import { saveExport } from './desktop.js'
import { encodePhoto } from './encode.js'
import { getImageWorkerDiagnostics } from './image-worker.js'
import { EXPORT_FORMATS, EXPORT_TYPES, exportFilename } from './formats.js'
import { Organization, namedVersion, findVersion } from './organization.js'
import { mountOrganization } from './organization-ui.js'
import { mergePhotos } from './merge.js'
import { mountMerge } from './merge-ui.js'
import { exportDng } from './dng.js'
import {
  validateOptics,
  compileOptics,
  listLensProfiles,
  matchLensProfiles,
  lensProfile,
  straighten
} from './optics.js'
import { mountOptics } from './optics-ui.js'
import * as migration from './migration.js'
import { mountMigration } from './migration-ui.js'
import { LOCAL_COMMANDS, updateLocalTools } from './local-tools.js'
import { createLocalToolsUI, viewToOriginal } from './local-tools-ui.js'
import { neutralBalance } from './white-balance.js'
import { analyzeFocus, validEye } from './culling.js'
import { validatePoint, pointPanel, sampleColor, clippingOverlay } from './point-color.js'
import { removeMaskedArea } from './fill.js'
import { generateAiMask } from './ai-mask.js'
import { estimateDepth } from './depth.js'
import { validateDepthSettings } from './depth-effects.js'
import { renderMaskPreview } from './mask-preview.js'
import { enhancePhoto } from './enhance.js'
import { mountEnhance } from './enhance-ui.js'

const $ = (id) => document.getElementById(id)
const option = (value, label) => new Option(label, value)
let photos = [],
  albums = [],
  selected = '',
  scope = 'all',
  mode = 'grid',
  search = '',
  order = 'recent'
let compare = false,
  film = true,
  zoom = false,
  cropping = false,
  bitmap = null,
  bitmapId = '',
  queue = Promise.resolve()
const urls = new Map(),
  undo = [],
  redo = []
const organization = new Organization()
const libraryHistory = new LibraryHistory()
const presets = new Presets()
let updateOrganization = () => {}
let updateMerge = () => {},
  updateStacks = () => {},
  updateEnhance = () => {}
const openStacks = new Set()
let slideTimer = null,
  slideDelay = 3000,
  gridLayout = localStorage.getItem('grid-layout') || 'square'
function scheduleSlide() {
  slideTimer = setTimeout(async () => {
    if (slideTimer === null) return
    const list = visible(),
      i = list.findIndex((p) => p.id === selected)
    if (list.length) await act('select', { id: list[(i + 1) % list.length].id })
    if (slideTimer !== null) scheduleSlide()
  }, slideDelay)
}
function stopSlides() {
  clearTimeout(slideTimer)
  slideTimer = null
  document.body.classList.remove('slideshow')
}
async function savePhotoRows(rows) {
  await db.withMedia(rows, (packed, commit) =>
    commit('photos', 'readwrite', (tx) => {
      for (const row of packed) tx.objectStore('photos').put(row)
    })
  )
  const changed = new Map(rows.map((row) => [row.id, row]))
  photos = photos.map((row) => changed.get(row.id) || row)
}
let localToolsUI, opticsUI, migrationUI
let sampling = false,
  pair = false,
  inspector = true,
  clipping = false,
  selectedPoint = ''
let updatePoints = () => {}
let playingMedia = null,
  frameTicket = 0,
  sliderFrame = 0
function stopPlayback() {
  playingMedia?.video.pause()
  cancelAnimationFrame(frameTicket)
}
function refreshPlayback() {
  if (!playingMedia || playingMedia.video.paused || !active() || mode !== 'detail') return
  const { video, duration } = playingMedia,
    photo = active()
  if (video.currentTime >= clipRange(photo.edit.trim, duration).end) stopPlayback()
  $('play-video').textContent = video.paused ? 'Play' : 'Pause'
  $('video-position').value = video.currentTime
  paintStage(video, photo.edit)
  if (!video.paused) frameTicket = requestAnimationFrame(refreshPlayback)
}
const active = () => photos.find((p) => p.id === selected)
const matches = (p) =>
  Boolean(p.deleted) === (scope === 'trash') &&
  (['all', 'trash'].includes(scope) ||
    (scope === 'picked'
      ? p.flag === 'pick'
      : p.albums.includes(scope) || smartMatch(p, albums.find((a) => a.id === scope)?.rule))) &&
  [p.name, p.keywords, p.metadata?.Make, p.metadata?.Model, p.metadata?.LensModel]
    .join(' ')
    .toLowerCase()
    .includes(search.toLowerCase()) &&
  organization.matches(p)
function visible() {
  const result = photos.filter(matches)
  return displayedPhotos(
    result.sort((a, b) => organization.compare(a, b, order)),
    openStacks
  )
}
async function source(id) {
  if (bitmapId !== id) {
    const data = await original(id)
    const photo = photos.find((p) => p.id === id)
    const media = isVideo(data.file) ? await openVideo(data.file) : null
    const next = media ? media.video : await decodePhoto(data.file)
    if (media) {
      photo.duration = media.duration
      await media.seek(clipRange(photo.edit.trim, media.duration).start)
    }
    stopPlayback()
    playingMedia?.close()
    playingMedia = media
    if (photo) {
      photo.width = next.width
      photo.height = next.height
      photo.metadata ??= await metadata(data.file)
    }
    localToolsUI?.unmount()
    opticsUI?.unmount()
    bitmap?.close?.()
    bitmap = next
    bitmapId = id
  }
  return bitmap
}
function original(id) {
  const photo = photos.find((p) => p.id === id)
  return local.isLocal(photo)
    ? local.original(photo)
    : photo?.reference
      ? migration.original(photo)
      : db.original(photo?.originalId ?? id)
}
function clearSources() {
  localToolsUI?.unmount()
  opticsUI?.unmount()
  stopPlayback()
  playingMedia?.close()
  playingMedia = null
  bitmap?.close?.()
  bitmap = null
  bitmapId = ''
  for (const id of urls.keys()) invalidate(id)
  undo.length = redo.length = 0
  libraryHistory.clear()
}
async function showLibrary() {
  local.leave()
  clearSources()
  organization.resetSelection()
  photos = await db.all('photos')
  selected = ''
  scope = 'all'
  mode = 'grid'
  compare = zoom = cropping = false
}
async function openLocal(root = '', relative = '', recursive = undefined) {
  const opened = await local.open(root, relative, recursive)
  if (!opened) return { canceled: true }
  organization.resetSelection()
  clearSources()
  photos = opened.photos
  selected = ''
  scope = 'all'
  mode = 'grid'
  compare = zoom = cropping = false
  search = $('search').value = ''
  if (opened.warnings.length) notice(opened.warnings.map((item) => item.name + ': ' + item.error).join('; '))
  return { folder: opened.folder, photos: photos.length, warnings: opened.warnings }
}
function thumb(photo) {
  if (!urls.has(photo.id)) urls.set(photo.id, URL.createObjectURL(photo.thumbnail))
  return urls.get(photo.id)
}
function invalidate(id) {
  if (urls.has(id)) URL.revokeObjectURL(urls.get(id))
  urls.delete(id)
}
function tile(photo) {
  const button = document.createElement('button'),
    img = new Image(),
    name = document.createElement('span')
  button.className =
    'tile' +
    (organization.selection.has(photo.id) ? ' selected' : '') +
    (selected === photo.id ? ' active' : '')
  button.setAttribute('aria-pressed', organization.selection.has(photo.id))
  button.dataset.photo = photo.id
  button.title = photo.name
  img.src = thumb(photo)
  img.alt = ''
  img.loading = 'lazy'
  name.textContent = displayName(photo)
  name.hidden = !preferences.filenames
  button.dataset.label = photo.label || ''
  button.style.setProperty('--aspect', photo.width && photo.height ? photo.width / photo.height : 1)
  button.append(img, name)
  local.observeThumbnail(photo, img, () => {
    if (photos.find((p) => p.id === photo.id) !== photo) return
    invalidate(photo.id)
    img.src = thumb(photo)
  })
  return button
}
function syncTiles(container, items) {
  const nodes = container.children
  if (nodes.length !== items.length || items.some((p, i) => nodes[i].dataset.photo !== p.id)) {
    container.replaceChildren(...items.map(tile))
  } else {
    items.forEach((p, i) => {
      const node = nodes[i],
        url = thumb(p)
      node.classList.toggle('selected', organization.selection.has(p.id))
      node.classList.toggle('active', p.id === selected)
      node.lastElementChild.textContent = displayName(p)
      node.lastElementChild.hidden = !preferences.filenames
      node.dataset.label = p.label || ''
      node.setAttribute('aria-pressed', organization.selection.has(p.id))
      if (node.firstChild.src !== url) node.firstChild.src = url
    })
  }
}
function paintStage(image, edit) {
  const recipe = cropping ? { ...edit, crop: null, aspect: '', turn: 0, flip: false } : compare ? {} : edit
  const stage = $('stage'),
    shape = geometry(image, recipe)
  const w = shape.turn % 2 ? shape.height : shape.width,
    h = shape.turn % 2 ? shape.width : shape.height
  const fit = Math.min((stage.clientWidth - 24) / w, (stage.clientHeight - 24) / h) * devicePixelRatio
  const edge = zoom ? Infinity : Math.max(1, Math.round(Math.max(w, h) * fit))
  const preview = render(image, recipe, edge)
  stage.classList.toggle('pair', pair)
  if (pair) stage.replaceChildren(render(image, {}, edge), preview)
  else stage.replaceChildren(preview)
  if (cropping) cropSurface.mount(preview, image, edit, selected)
  else cropSurface.reset()
  localToolsUI?.mount(preview, {
    image,
    edit: recipe,
    enabled: !playingMedia && !cropping && !compare && !sampling && !pair
  })
  opticsUI?.mount(preview, {
    image,
    edit: recipe,
    available: !playingMedia && !cropping && !compare && !sampling && !pair
  })
  if ($('histogram-panel').open) drawHistogram($('histogram'), histogram(preview))
  if (clipping) clippingOverlay(preview)
  $('stage').classList.toggle('cropping', cropping)
  $('stage').classList.toggle('zoom', zoom)
}
async function draw() {
  local.drawNavigation()
  const list = visible()
  selected = organization.reconcile(list, selected)
  if (!selected) mode = 'grid'
  const p = active(),
    detail = mode === 'detail'
  if (!detail || bitmapId !== selected) {
    localToolsUI?.unmount()
    opticsUI?.unmount()
  }
  $('count').textContent = list.length
  $('heading').textContent =
    local.state() && scope === 'all'
      ? local.state().relative === '.'
        ? local.state().root.name
        : local.state().relative
      : albums.find((a) => a.id === scope)?.name ||
        { all: 'All photos', picked: 'Flagged', trash: 'Deleted' }[scope]
  $('gallery').hidden = detail
  $('film').hidden = !detail || !film
  $('stage').hidden = !detail
  document.querySelector('aside').hidden = !detail || !inspector || p?.deleted
  $('actions').hidden = !p
  $('export').disabled = !p
  $('detail').disabled = !p
  syncTiles($('gallery'), detail ? [] : list)
  syncTiles($('film'), detail && film ? list : [])
  if (!list.length && scope === 'all' && !search) {
    const add = document.createElement('button')
    add.className = 'empty'
    add.textContent = local.state() ? 'Open another folder…' : 'Add photos'
    add.onclick = () => (local.state() ? act('local-open') : choosePhotos())
    $('gallery').replaceChildren(add)
  } else if (!list.length) {
    const empty = document.createElement('span')
    empty.className = 'empty'
    empty.textContent = search ? 'No matching photos' : scope === 'trash' ? 'No deleted photos' : 'No photos'
    $('gallery').replaceChildren(empty)
  }
  $('albums').replaceChildren(
    ...albums.map((a) => {
      const btn = document.createElement('button')
      btn.dataset.scope = a.id
      btn.textContent = a.name
      btn.disabled = Boolean(local.state())
      return btn
    })
  )
  document
    .querySelectorAll('[data-scope]')
    .forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.scope === scope))
  $('filename').textContent = p?.name || ''
  $('new-album').disabled = Boolean(local.state())
  presets.render($('preset-list'))
  $('preset-delete').disabled = presets.builtIn($('preset-list').value)
  const current = snapshot()
  updateOrganization(current)
  updateStacks(current)
  $('gallery').dataset.layout = gridLayout
  updateMerge(snapshot())
  updateEnhance(snapshot())
  localToolsUI?.sync()
  opticsUI?.sync()
  if (!p) {
    stopPlayback()
    $('video-bar').hidden = true
    return
  }
  $('rate').value = p.rating
  $('color-label').value = p.label || ''
  $('flag').value = p.flag
  $('keywords').value = p.keywords
  $('delete').textContent = p.deleted ? 'Restore' : 'Delete'
  $('membership').replaceChildren(
    option('', 'Albums'),
    ...albums
      .filter((a) => !a.rule)
      .map((a) => option(a.id, (p.albums.includes(a.id) ? '− ' : '＋ ') + a.name))
  )
  $('membership').disabled = Boolean(local.state())
  $('info').textContent =
    describe(p) +
    (p.review
      ? '\nFocus ' +
        p.review.focus +
        ' · ' +
        p.review.faces.length +
        ' faces · ' +
        Math.round((p.review.white + p.review.black) * 100) +
        '% clipped'
      : '')
  $('rename-photo').value = p.name
  const captured = new Date(p.metadata?.DateTimeOriginal || p.added)
  $('capture-time').value = Number.isNaN(+captured)
    ? ''
    : new Date(+captured - captured.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
  $('purge').hidden = !p.deleted || Boolean(local.state())
  $('compare').setAttribute('aria-pressed', compare)
  $('pair').setAttribute('aria-pressed', pair)
  $('sample').setAttribute('aria-pressed', sampling === 'white')
  $('remove-mask').disabled = !p.edit.localTools?.masks?.length
  $('clip-indicator').setAttribute('aria-pressed', clipping)
  updatePoints(p.edit.pointColors || [], selectedPoint)
  selectedPoint = ''
  $('aspect').value = p.edit.aspect || ''
  $('crop-tool').textContent = cropping ? 'Done' : 'Crop area'
  for (const input of document.querySelectorAll('[data-control]')) {
    input.value = p.edit[input.dataset.control] || 0
    input.previousElementSibling.value = input.value
  }
  if (detail) paintStage(await source(p.id), p.edit)
  else stopPlayback()
  const video = detail && isVideo(p) && playingMedia
  $('video-bar').hidden = !video
  if (video) {
    const range = clipRange(p.edit.trim, video.duration)
    $('video-position').max = video.duration
    $('video-position').value = video.video.currentTime
    $('trim-start').value = range.start
    $('trim-end').value = Number(range.end.toFixed(3))
    $('play-video').textContent = video.video.paused ? 'Play' : 'Pause'
  }
}
function cropDraft() {
  return cropping && cropSurface.owner === selected ? { ...cropSurface.box } : null
}
function snapshot() {
  const items = visible().map(({ thumbnail, ...p }) => p)
  return {
    openStacks: [...openStacks],
    slideshow: slideTimer !== null,
    gridLayout,
    playback:
      playingMedia && selected === bitmapId
        ? {
            time: playingMedia.video.currentTime,
            playing: !playingMedia.video.paused,
            duration: playingMedia.duration
          }
        : null,
    codecDiagnostics: getImageWorkerDiagnostics(),
    selected,
    scope,
    mode,
    inspector,
    search,
    order,
    compare,
    pair,
    sampling,
    cropping,
    cropDraft: cropDraft(),
    localSelection: localToolsUI?.selection(),
    film,
    zoom,
    albums,
    photos: items,
    local: local.state(),
    selection: [...organization.selection],
    filters: { ...organization.filters },
    sortDirection: organization.direction,
    clipboard: organization.clipboard
      ? { source: organization.clipboard.source, keys: organization.clipboard.keys }
      : null
  }
}
async function importFiles(files, deduplicate = false) {
  const album = albums.find((a) => a.id === scope && !a.rule)?.id
  const result = await importBatch(files, {
    photos,
    album,
    readOriginal: original,
    deduplicate,
    async update(photo, settings) {
      await replace(photo, settings)
      if (settings.edit) {
        undo.push({ id: photo.id, edit: photo.edit })
        redo.length = 0
      }
    }
  })
  const first = result.added[0] ?? result.existing[0]
  if (first) {
    if (!albums.some((a) => a.id === scope)) scope = 'all'
    search = $('search').value = ''
    selected = first
    organization.resetSelection()
    organization.selection = new Set([first])
    mode = 'grid'
  }
  return result
}
const groups = Object.assign({}, ...Object.values(controls))
export { commands } from './agent-protocol.js'

async function preparePhoto(p, changes) {
  const next = { ...p, ...changes }
  if (changes.edit) next.thumbnail = await toBlob(render(await source(p.id), changes.edit, 240))
  return next
}
async function replace(p, changes) {
  const next = await preparePhoto(p, changes)
  if (local.isLocal(next)) await local.save(next)
  else await db.save('photos', next)
  photos[photos.indexOf(p)] = next
  if (changes.edit) invalidate(p.id)
}
function enumValue(v, values) {
  if (!values.includes(v)) throw Error('Expected ' + values.join(', '))
  return v
}
function number(v, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw Error('Expected a number between ' + min + ' and ' + max)
  return v
}
async function applySelection(changes, recordUndo = false) {
  const targets = organization.targets(photos)
  if (!targets.length) throw Error('Select at least one photo')
  if (!local.state()) {
    const rows = []
    for (const photo of targets) rows.push(await preparePhoto(photo, changes(photo)))
    await savePhotoRows(rows)
    if (recordUndo) {
      for (const p of targets) {
        undo.push({ id: p.id, edit: p.edit })
        invalidate(p.id)
      }
      redo.length = 0
      compare = false
    }
    return
  }
  let completed = 0
  try {
    for (const photo of targets) {
      await replace(photo, changes(photo))
      if (recordUndo) undo.push({ id: photo.id, edit: photo.edit })
      completed++
    }
  } catch (error) {
    await draw()
    throw Error('Updated ' + completed + ' of ' + targets.length + ' photos: ' + error.message)
  }
  if (recordUndo) {
    redo.length = 0
    compare = false
  }
}
async function execute(command, args) {
  const p = active()
  if (
    [
      'view',
      'local-tool',
      'crop-tool',
      'sample-tool',
      'compare',
      'compare-pair',
      'select',
      'scope',
      'library',
      'local-open',
      'local-browse'
    ].includes(command)
  )
    opticsUI?.deactivate()
  let result
  const advance =
    (command === 'rate' || command === 'flag') &&
    (args.advance ?? preferences.autoAdvance) &&
    organization.selection.size === 1
  const nextId = advance ? visible()[visible().findIndex((row) => row.id === selected) + 1]?.id : null
  switch (command) {
    case 'library-undo':
    case 'library-redo': {
      if (local.state()) throw Error('Open the photo library first')
      await libraryHistory.replay(command === 'library-undo', async (step, key) => {
        const byId = new Map(photos.map((p) => [p.id, p]))
        const rows = step.rows
          .filter((change) => byId.has(change.id))
          .map((change) => ({ ...byId.get(change.id), ...change[key] }))
        await db.withMedia(rows, (packed, commit) =>
          commit(['photos', 'albums'], 'readwrite', (tx) => {
            for (const row of packed) tx.objectStore('photos').put(row)
            for (const change of step.albums) {
              if (change[key]) tx.objectStore('albums').put(change[key])
              else tx.objectStore('albums').delete(change.id)
            }
          })
        )
        const updated = new Map(rows.map((row) => [row.id, row]))
        photos = photos.map((row) => updated.get(row.id) || row)
        albums = await db.all('albums')
        if (!['trash', 'all', 'picked'].includes(scope) && !albums.some((a) => a.id === scope)) scope = 'all'
        organization.resetSelection()
      })
      break
    }
    case 'state': {
      if (!args.summary) return snapshot()
      const photo = active()
      return {
        selected,
        scope,
        mode,
        visibleCount: visible().length,
        selectionCount: organization.selection.size,
        cropDraft: cropDraft(),
        localSelection: localToolsUI?.selection(),
        photo: photo
          ? {
              id: photo.id,
              name: photo.name,
              rating: photo.rating,
              flag: photo.flag,
              width: photo.width,
              height: photo.height
            }
          : null
      }
    }
    case 'photos': {
      const list = visible(),
        offset = number(args.offset ?? 0, 0, Number.MAX_SAFE_INTEGER),
        limit = number(args.limit ?? 50, 1, Number.MAX_SAFE_INTEGER)
      return {
        total: list.length,
        offset,
        photos: list
          .slice(offset, offset + limit)
          .map(({ id, name, rating, flag, width, height, keywords }) => ({
            id,
            name,
            rating,
            flag,
            width,
            height,
            keywords
          }))
      }
    }
    case 'preferences':
      if (!Object.keys(args).length) return { ...preferences }
      result = setPreferences(args)
      break
    case 'select-inverse':
      selected = organization.chooseMany(
        visible(),
        visible()
          .filter((row) => !organization.selection.has(row.id))
          .map((row) => row.id)
      )
      break
    case 'grid-layout':
      gridLayout = enumValue(args.layout, ['square', 'mosaic'])
      localStorage.setItem('grid-layout', gridLayout)
      mode = 'grid'
      break
    case 'stack':
    case 'auto-stack': {
      if (local.state()) throw Error('Stacks belong to the photo library')
      const by = enumValue(args.by || 'time', ['time', 'similarity'])
      const groups =
        command === 'stack'
          ? [organization.targets(photos)]
          : await findStacks(
              visible(),
              by,
              number(args.threshold ?? (by === 'time' ? 5 : 0.07), 0, by === 'time' ? 86400 : 1)
            )
      const rows = []
      for (const group of groups) {
        if (group.length < 2) throw Error('Select at least two photos')
        if (group.some((p) => p.stackId)) throw Error('Ungroup existing stacks first')
        const id = crypto.randomUUID(),
          cover = group.find((p) => p.id === selected) || group[0]
        for (const p of group) rows.push({ ...p, stackId: id, stackCover: p.id === cover.id })
      }
      await savePhotoRows(rows)
      organization.resetSelection()
      result = { groups: groups.length, photos: rows.length }
      break
    }
    case 'unstack':
    case 'stack-cover':
    case 'stack-toggle': {
      if (!p?.stackId) throw Error('Select a stack')
      if (command === 'stack-toggle') {
        if (openStacks.has(p.stackId)) openStacks.delete(p.stackId)
        else openStacks.add(p.stackId)
      } else {
        const group = photos.filter((row) => row.stackId === p.stackId)
        await savePhotoRows(
          group.map((row) => ({
            ...row,
            stackId: command === 'unstack' ? null : p.stackId,
            stackCover: command !== 'unstack' && row.id === p.id
          }))
        )
      }
      break
    }
    case 'virtual-copy': {
      if (!p || local.state()) throw Error('Select a library photo')
      const copy = {
        ...p,
        id: crypto.randomUUID(),
        originalId: p.originalId || p.id,
        virtual: true,
        added: Date.now(),
        stackId: null,
        stackCover: false,
        versions: []
      }
      await db.save('photos', copy)
      photos.push(copy)
      selected = organization.chooseMany(photos, [copy.id])
      break
    }
    case 'slideshow': {
      if (slideTimer !== null || args.stop) {
        stopSlides()
        break
      }
      if (!visible().length) throw Error('No photos in this view')
      slideDelay = number(args.seconds ?? 3, 0.2, 3600) * 1000
      mode = 'detail'
      document.body.classList.add('slideshow')
      scheduleSlide()
      break
    }
    case 'save-frame': {
      if (!p || !isVideo(p)) throw Error('Select a video')
      const canvas = render(await source(p.id), p.edit),
        blob = await toBlob(canvas, 'image/png')
      const file = new File(
        [blob],
        p.name.replace(/\.[^.]+$/, '') + '-' + Math.round(playingMedia.video.currentTime * 1000) + '.png',
        { type: 'image/png' }
      )
      if (local.state()) await showLibrary()
      result = await importFiles([file])
      break
    }
    case 'clipping':
      clipping = !clipping
      mode = 'detail'
      break
    case 'sample-tool':
    case 'point-tool': {
      if (!p) throw Error('Select a photo first')
      const tool = command === 'point-tool' ? 'point' : 'white'
      mode = 'detail'
      sampling = sampling === tool ? false : tool
      pair = cropping = compare = clipping = false
      break
    }
    case 'compare-pair':
      if (!p) throw Error('Select a photo first')
      mode = 'detail'
      pair = !pair
      sampling = compare = cropping = zoom = false
      break
    case 'sync': {
      if (!globalThis.mygo?.call) throw Error('Sync requires the desktop app')
      result = await synchronize(
        { ...args, prefer: enumValue(args.prefer || '', ['', 'local', 'remote']) },
        undefined,
        (photo) => (photo.reference ? migration.original(photo) : db.original(photo.originalId || photo.id))
      )
      if (result.synced) {
        if (!local.state()) {
          clearSources()
          photos = await db.all('photos')
        }
        albums = await db.all('albums')
        await presets.load()
        if (!['all', 'picked', 'trash'].includes(scope) && !albums.some((a) => a.id === scope)) scope = 'all'
      }
      break
    }
    case 'lens-profiles':
      return listLensProfiles(args.query)
    case 'lens-match': {
      if (!p || isVideo(p)) throw Error('Select a photo to match camera and lens metadata')
      p.metadata ??= await metadata((await original(p.id)).file)
      return matchLensProfiles(p.metadata)
    }
    case 'straighten-tool': {
      if (!p || isVideo(p)) throw Error('Select a photo to straighten')
      mode = 'detail'
      inspector = true
      compare = cropping = pair = sampling = false
      localToolsUI.deactivate()
      opticsUI.setMode(enumValue(args.axis ?? 'horizontal', ['horizontal', 'vertical']))
      break
    }
    case 'presets':
      return presets.items
    case 'preset-delete':
      await presets.remove(args.id)
      break
    case 'import':
      if (local.state()) await showLibrary()
      result = await importFiles(args.files, true)
      break
    case 'local-folders':
      return (await globalThis.mygo?.call('Local.Folders')) ?? []
    case 'local-open':
      result = await openLocal(args.root || '', args.relative || '', args.recursive)
      break
    case 'local-subfolders': {
      const folder = local.state()
      if (!folder) throw Error('Open a local folder first')
      result = await openLocal(folder.root.id, folder.relative, args.enabled)
      break
    }
    case 'local-browse':
      if (!local.state()) throw Error('Open a local folder first')
      result = await openLocal(local.state().root.id, args.relative || '.')
      break
    case 'library':
      await showLibrary()
      break
    case 'migrate-lrcat':
      return migrationUI.show('lrcat')
    case 'migrate-apple-photos':
      return migrationUI.show('apple-export')
    case 'migration-scan':
      return migration.scan(args.catalog)
    case 'migration-folder':
      return migration.chooseFolder()
    case 'migration-apple-scan':
      return migration.scanApple(args.root)
    case 'migration-map':
      return migration.mapRoot(args)
    case 'migration-inspect':
      return migration.inspect(args.id)
    case 'migration-report':
      return migration.report(args.id)
    case 'migration-commit':
    case 'migration-retry': {
      result = await migration.commit(args.id)
      await showLibrary()
      albums = await db.all('albums')
      selected = result.imported[0]?.id ?? result.existing[0]?.id ?? ''
      organization.resetSelection()
      if (selected) organization.selection.add(selected)
      break
    }
    case 'share-configure':
      return sharing.configure(args)
    case 'share-publish':
    case 'share-reviews':
    case 'share-revoke': {
      if (local.state()) throw Error('Share an album from Photo library')
      const album = albums.find((album) => album.id === (args.album || scope))
      if (!album) throw Error('Select a library album first')
      if (command === 'share-reviews') return sharing.reviews(album.id)
      if (command === 'share-revoke') return sharing.revoke(album.id)
      return sharing.publish(
        album,
        photos.filter(
          (photo) => !photo.deleted && (photo.albums.includes(album.id) || smartMatch(photo, album.rule))
        ),
        source,
        args
      )
    }
    case 'tether':
      return camera.show()
    case 'camera-list':
      return camera.discover()
    case 'camera-capture': {
      const shot = await camera.capture(args.id)
      if (local.state()) await showLibrary()
      const added = await importFiles(shot.files)
      for (const id of added.added) {
        const photo = photos.find((photo) => photo.id === id)
        await replace(photo, {
          cameraCapture: {
            device: shot.device.name,
            backend: shot.device.backend,
            simulated: shot.device.simulated,
            captured: new Date().toISOString()
          }
        })
      }
      result = { ...added, device: shot.device }
      break
    }
    case 'external-editor':
      return external.choose(Boolean(args.photoshop))
    case 'external-edit': {
      if (!p || isVideo(p)) throw Error('Select a photo for external editing')
      const copy = await execute('export', { format: 'image/tiff' })
      const sent = await external.send(copy.blob, copy.filename, p.id)
      notice('Save the TIFF in your editor to bring the edited copy back.')
      return sent
    }
    case 'external-check': {
      const saved = await external.changes(),
        imported = []
      if (!saved.length) return { imported }
      const catalog = await db.all('photos')
      for (const item of saved) {
        const existing = catalog.find(
          (photo) => photo.externalSession === item.id && photo.externalRevision === item.hash
        )
        if (!existing) {
          if (local.state()) await showLibrary()
          const added = await importFiles([item.file])
          if (added.failed.length) throw Error(added.failed[0].error)
          const photo = photos.find((photo) => photo.id === added.added[0])
          await replace(photo, {
            derivedFrom: item.sourceId,
            externalSession: item.id,
            externalRevision: item.hash
          })
          imported.push(photo.id)
        }
        await external.acknowledge(item)
      }
      if (imported.length) notice('Saved external copy added to Photo library')
      result = { imported }
      break
    }
    case 'select':
      selected = organization.choose(visible(), selected, args)
      compare = zoom = false
      break
    case 'select-many':
      selected = organization.chooseMany(visible(), args.ids)
      compare = zoom = false
      break
    case 'select-all':
      selected = organization.chooseMany(
        visible(),
        visible().map((p) => p.id)
      )
      break
    case 'enhance': {
      if (!p || isVideo(p)) throw Error('Select a photo to enhance')
      if (args.photoId !== undefined && args.photoId !== p.id)
        throw Error('The selected photo changed; enhancement was canceled')
      const inputEdit = p.edit,
        enhanced = await enhancePhoto(await source(p.id), p.edit, args)
      if (active()?.id !== p.id || active()?.edit !== inputEdit)
        throw Error('The photo or edits changed; enhancement was canceled')
      const suffix = (args.mode ?? 'denoise') === 'denoise' ? '-Denoised' : '-Enhanced-3x',
        file = new File([enhanced.blob], p.name.replace(/\.[^.]+$/, '') + suffix + '.png', {
          type: 'image/png'
        })
      const photo = {
        id: crypto.randomUUID(),
        name: file.name,
        width: enhanced.width,
        height: enhanced.height,
        mediaType: 'image/png',
        added: Date.now(),
        rating: 0,
        flag: '',
        keywords: '',
        deleted: false,
        albums: [],
        edit: {},
        metadata: {},
        thumbnail: enhanced.thumbnail,
        enhance: {
          ...enhanced.provenance,
          metrics: enhanced.metrics,
          sourceId: p.id,
          sourceName: p.name,
          sourceEdit: inputEdit
        }
      }
      await db.addPhoto(photo, file)
      if (local.state()) await showLibrary()
      else photos.push(photo)
      scope = 'all'
      search = $('search').value = ''
      organization.setFilters({ rating: 0, flag: 'any', edited: 'any' })
      selected = organization.chooseMany(photos, [photo.id])
      mode = 'detail'
      compare = zoom = cropping = false
      result = {
        id: photo.id,
        name: photo.name,
        width: photo.width,
        height: photo.height,
        enhance: photo.enhance
      }
      break
    }
    case 'merge-hdr':
    case 'merge-panorama': {
      const ids = args.ids ?? [...organization.selection]
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length)
        throw Error('Merge source IDs must be a unique array')
      const sources = ids.map((id) => visible().find((photo) => photo.id === id))
      if (sources.some((photo) => !photo)) throw Error('Every merge source must be in the current view')
      const merged = await mergePhotos(command === 'merge-hdr' ? 'hdr' : 'panorama', sources, original, args)
      const photo = {
        id: crypto.randomUUID(),
        name: merged.file.name,
        width: merged.width,
        height: merged.height,
        added: Date.now(),
        rating: 0,
        flag: '',
        keywords: '',
        deleted: false,
        albums: [],
        edit: {},
        metadata: {},
        thumbnail: merged.thumbnail,
        merge: merged.diagnostics
      }
      await db.addPhoto(photo, merged.file, merged.radiance ? { radiance: merged.radiance } : {})
      if (local.state()) await showLibrary()
      else photos.push(photo)
      scope = 'all'
      search = $('search').value = ''
      organization.setFilters({ rating: 0, flag: 'any', edited: 'any' })
      selected = organization.chooseMany(photos, [photo.id])
      mode = 'detail'
      compare = zoom = cropping = false
      result = {
        id: photo.id,
        name: photo.name,
        width: photo.width,
        height: photo.height,
        merge: photo.merge
      }
      break
    }
    case 'filter':
      organization.setFilters(args)
      break
    case 'view':
      mode = enumValue(args.mode, ['grid', 'detail'])
      inspector = args.inspector ?? true
      cropping = pair = sampling = false
      break
    case 'local-tool': {
      if (!p) throw Error('Select a photo first')
      mode = 'detail'
      inspector = true
      pair = sampling = compare = cropping = false
      localToolsUI.setMode(enumValue(args.tool, ['off', 'brush', 'linear', 'radial', 'clone', 'heal']))
      opticsUI?.deactivate()
      break
    }
    case 'panel': {
      if (args.name === 'photos') {
        const nav = document.querySelector('nav')
        nav.hidden = !nav.hidden
        break
      }
      const panel = [...document.querySelectorAll('aside details')].find(
        (el) => el.querySelector('summary')?.textContent === args.name
      )
      if (!panel) throw Error('Unknown panel')
      mode = 'detail'
      inspector = true
      panel.open = args.open ?? !panel.open
      if (panel.open) requestAnimationFrame(() => panel.scrollIntoView({ block: 'nearest' }))
      break
    }
    case 'fullscreen': {
      if (globalThis.mygo?.call) await globalThis.mygo.call('Desktop.ToggleFullscreen')
      else if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
      break
    }
    case 'crop-drag':
    case 'crop-nudge':
      if (!cropping || !p || cropSurface.owner !== p.id) throw Error('Open the crop tool first')
      if (cropSurface.drag) throw Error('Finish dragging the crop rectangle first')
      if (command === 'crop-nudge') cropSurface.nudge(args.dx, args.dy)
      else
        cropSurface.reshape(
          cropSurface.box,
          args.grip,
          { x: args.x1, y: args.y1 },
          { x: args.x2, y: args.y2 },
          args.lockAspect
        )
      return { cropDraft: cropDraft() }
    case 'crop-cancel':
      cropping = false
      cropSurface.reset()
      break
    case 'crop-tool': {
      if (!p) throw Error('Select a photo first')
      if (cropping && cropSurface.changed && cropSurface.owner === p.id) {
        await replace(p, { edit: { ...p.edit, crop: cropSurface.box } })
        undo.push({ id: p.id, edit: p.edit })
        redo.length = 0
      }
      mode = 'detail'
      inspector = true
      compare = zoom = false
      cropping = !cropping
      sampling = pair = false
      cropSurface.reset()
      $('crop-tool').closest('details').open = true
      break
    }
    case 'search':
      search = $('search').value = String(args.text)
      organization.resetSelection()
      break
    case 'sort':
      order = $('order').value = enumValue(args.order, ['recent', 'name', 'rating', 'capture', 'focus'])
      organization.direction = enumValue(args.direction ?? (order === 'name' ? 'asc' : 'desc'), [
        'asc',
        'desc'
      ])
      break
    case 'scope':
      if (local.state() && albums.some((album) => album.id === args.id))
        throw Error('Albums belong to the imported library; switch to Library first')
      scope = enumValue(args.id, ['all', 'trash', 'picked', ...albums.map((a) => a.id)])
      mode = 'grid'
      organization.resetSelection()
      break
    case 'album': {
      const name = String(args.name ?? '').trim()
      if (!name) throw Error('Enter an album name')
      const album = {
        id: crypto.randomUUID(),
        name,
        ...(args.smart ? { rule: { ...organization.filters, text: search } } : {})
      }
      await db.save('albums', album)
      albums.push(album)
      result = album
      break
    }
    case 'film':
      film = !film
      break
    case 'album-rename': {
      const album = albums.find((a) => a.id === args.id),
        name = String(args.name ?? '').trim()
      if (!album) throw Error('Album not found')
      if (!name) throw Error('Enter an album name')
      const next = { ...album, name }
      await db.save('albums', next)
      albums[albums.indexOf(album)] = next
      break
    }
    case 'album-delete': {
      if (!albums.some((a) => a.id === args.id)) throw Error('Album not found')
      await db.removeAlbum(args.id)
      albums = albums.filter((a) => a.id !== args.id)
      photos = photos.map((photo) => ({ ...photo, albums: photo.albums.filter((id) => id !== args.id) }))
      if (scope === args.id) {
        scope = 'all'
        organization.resetSelection()
      }
      break
    }
    default: {
      if (!p) throw Error('Select a photo first')
      if (LOCAL_COMMANDS.includes(command)) {
        if (args.photoId !== undefined && args.photoId !== p.id)
          throw Error('The selected photo changed; local edit was canceled')
        const edit = updateLocalTools(p.edit, command, args)
        await replace(p, { edit })
        undo.push({ id: p.id, edit: p.edit })
        redo.length = 0
        compare = cropping = false
        await draw()
        if (command === 'mask.add' || command === 'mask.combine')
          localToolsUI.selectMask(command === 'mask.add' ? edit.localTools.masks.at(-1).id : args.id)
        return snapshot()
      }
      switch (command) {
        case 'local-select':
          if (args.photoId !== undefined && args.photoId !== p.id) throw Error('The selected photo changed')
          return localToolsUI.select(args.id, args.path)
        case 'mask-overlay':
          return { visible: localToolsUI.setOverlay(args.enabled) }
        case 'mask-preview': {
          const masks = p.edit.localTools?.masks
          const tool =
            args.id !== undefined
              ? masks?.find((mask) => mask.id === args.id)
              : (localToolsUI.selectedItem() ?? masks?.at(-1))
          if (!tool || ['clone', 'heal'].includes(tool.type)) throw Error('Choose an existing mask')
          const canvas = renderMaskPreview(await source(p.id), p.edit, tool, {
            style: args.style ?? 'gray',
            maxSize: args.maxSize ?? Infinity
          })
          return {
            blob: await toBlob(canvas, 'image/png'),
            filename: p.name.replace(/\.[^.]+$/, '') + '-mask.png'
          }
        }
        case 'optics':
        case 'lens-apply':
        case 'optics-reset':
        case 'straighten': {
          if (isVideo(p)) throw Error('Optics and geometry correction require a still photo')
          if (args.photoId !== undefined && args.photoId !== p.id)
            throw Error('The selected photo changed; optics edit was canceled')
          await source(p.id)
          let optics
          if (command === 'optics') optics = validateOptics({ ...p.edit.optics, ...args.changes })
          if (command === 'lens-apply') {
            const matched = matchLensProfiles(p.metadata),
              cropFactor =
                args.cropFactor ?? (matched.cameras.length === 1 ? matched.cameras[0].cropFactor : undefined)
            optics = validateOptics({
              ...p.edit.optics,
              enabled: true,
              profile: lensProfile(args.id, args.focal ?? p.metadata?.FocalLength, cropFactor),
              profileDistortion: true,
              profileTCA: true
            })
          }
          if (command === 'straighten') {
            const axis = enumValue(args.axis ?? 'horizontal', ['horizontal', 'vertical']),
              baseAxis = (p.edit.turn || 0) % 2 ? (axis === 'horizontal' ? 'vertical' : 'horizontal') : axis
            optics = straighten(p, p.edit.optics, args.start, args.end, baseAxis)
          }
          if (optics) compileOptics(p, optics)
          const { optics: previous, ...other } = p.edit
          await replace(p, { edit: optics ? { ...other, optics } : other })
          undo.push({ id: p.id, edit: p.edit })
          redo.length = 0
          compare = cropping = false
          break
        }
        case 'depth-estimate':
        case 'depth-range':
        case 'lens-blur': {
          if (args.photoId !== undefined && args.photoId !== p.id)
            throw Error('The selected photo changed; depth operation was canceled')
          const inputEdit = p.edit,
            localTools = { ...p.edit.localTools }
          let settings
          if (command === 'lens-blur')
            settings = validateDepthSettings({
              ...localTools.lensBlur,
              ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'photoId'))
            })
          if (!localTools.depth && (command !== 'lens-blur' || settings.enabled))
            localTools.depth = await estimateDepth(await source(p.id))
          if (active()?.id !== p.id || active()?.edit !== inputEdit)
            throw Error('The photo or edits changed; depth operation was canceled')
          let edit = { ...p.edit, localTools }
          if (command === 'depth-range')
            edit = updateLocalTools(edit, 'mask.add', {
              mask: {
                type: 'depth-range',
                raster: localTools.depth.raster,
                provenance: localTools.depth.provenance,
                min: args.min ?? 0.2,
                max: args.max ?? 0.5,
                softness: args.softness ?? 0.1,
                adjustments: args.adjustments ?? {}
              }
            })
          if (command === 'lens-blur') localTools.lensBlur = settings
          await replace(p, { edit })
          undo.push({ id: p.id, edit: p.edit })
          redo.length = 0
          compare = cropping = false
          await draw()
          if (command === 'depth-range') localToolsUI.selectMask(edit.localTools.masks.at(-1).id)
          return {
            depth: localTools.depth?.provenance,
            metrics: localTools.depth?.metrics,
            lensBlur: localTools.lensBlur,
            maskId: command === 'depth-range' ? edit.localTools.masks.at(-1).id : undefined
          }
        }
        case 'ai-mask': {
          if (args.photoId !== undefined && args.photoId !== p.id)
            throw Error('The selected photo changed; AI mask was canceled')
          const inputEdit = p.edit,
            result = await generateAiMask(await source(p.id), {
              target: args.target,
              adjustments: args.adjustments
            })
          if (active()?.id !== p.id || active()?.edit !== inputEdit)
            throw Error('The photo or edits changed; AI mask was canceled')
          const edit = updateLocalTools(p.edit, 'mask.add', { mask: result.mask })
          await replace(p, { edit })
          undo.push({ id: p.id, edit: p.edit })
          redo.length = 0
          compare = cropping = false
          await draw()
          localToolsUI.selectMask(edit.localTools.masks.at(-1).id)
          return { id: edit.localTools.masks.at(-1).id, target: args.target, metrics: result.metrics }
        }
        case 'rate':
          if (!Number.isInteger(args.value)) throw Error('Rating must be an integer')
          number(args.value, 0, 5)
          await applySelection(() => ({ rating: args.value }))
          break
        case 'flag':
          enumValue(args.value, ['', 'pick', 'reject'])
          await applySelection(() => ({ flag: args.value }))
          break
        case 'cull': {
          const targets = args.ids
            ? args.ids.map((id) => photos.find((row) => row.id === id))
            : organization.targets(photos)
          if (!targets.length || targets.some((photo) => !photo || photo.deleted))
            throw Error('Select library photos to review')
          const scores = []
          for (const photo of targets) {
            const review = await analyzeFocus(await source(photo.id))
            scores.push({ id: photo.id, review })
          }
          if (local.state()) {
            for (const { id, review } of scores)
              await replace(
                photos.find((row) => row.id === id),
                { review }
              )
          } else {
            const scoresById = new Map(scores.map((row) => [row.id, row.review]))
            await savePhotoRows(targets.map((photo) => ({ ...photo, review: scoresById.get(photo.id) })))
          }
          result = { scores }
          break
        }
        case 'red-eye': {
          const image = await source(p.id)
          let eyes
          if (args.x !== undefined || args.y !== undefined) {
            const radius = number(args.radius ?? 0.015, 0.001, 0.5) * Math.min(image.width, image.height)
            eyes = [
              {
                x: number(args.x, 0, 1),
                y: number(args.y, 0, 1),
                rx: radius / image.width,
                ry: radius / image.height
              }
            ]
          } else {
            const review = p.review ?? (await analyzeFocus(image))
            eyes = review.faces
              .flatMap((face) => face.eyes.map(({ x, y, rx, ry }) => ({ x, y, rx, ry })))
              .filter(validEye)
          }
          if (eyes.length) {
            await replace(p, { edit: { ...p.edit, redEyes: [...(p.edit.redEyes || []), ...eyes] } })
            undo.push({ id: p.id, edit: p.edit })
            redo.length = 0
          }
          result = { eyeRegions: eyes.length }
          break
        }
        case 'capture-time': {
          const date = new Date(args.time)
          if (!Number.isFinite(+date)) throw Error('Enter a valid capture date')
          await applySelection((photo) => ({
            metadata: { ...photo.metadata, DateTimeOriginal: date.toISOString() }
          }))
          break
        }
        case 'rename': {
          if (local.state()) throw Error('Rename local originals in their source folder')
          const name = String(args.name || '').trim()
          if (
            !name ||
            [...name].some((c) => c === '/' || c.charCodeAt(0) === 92 || c.charCodeAt(0) < 32) ||
            ['.', '..'].includes(name)
          )
            throw Error('Enter a file name without folders')
          await replace(p, { name })
          break
        }
        case 'purge': {
          const targets = organization.targets(photos)
          if (local.state() || !targets.length || targets.some((photo) => !photo.deleted))
            throw Error('Select deleted library photos')
          const ids = new Set(targets.map((photo) => photo.id)),
            remaining = photos.filter((photo) => !ids.has(photo.id))
          const referenced = new Set(remaining.map((photo) => photo.originalId || photo.id))
          await db.transaction(['photos', 'originals'], 'readwrite', (tx) => {
            for (const photo of targets) {
              db.deleteRecord(tx, 'photos', photo.id)
              const sourceId = photo.originalId || photo.id
              if (!referenced.has(sourceId)) db.deleteRecord(tx, 'originals', sourceId)
            }
          })
          for (const id of ids) invalidate(id)
          photos = remaining
          clearSources()
          organization.resetSelection()
          break
        }
        case 'label':
          await applySelection(() => ({ label: enumValue(args.value, colorLabels) }))
          break
        case 'keywords':
          await applySelection(() => ({ keywords: String(args.value) }))
          break
        case 'delete':
        case 'restore':
          await applySelection(() => ({ deleted: command === 'delete' }))
          break
        case 'membership': {
          if (local.state()) throw Error('Import local photos into Library before adding them to albums')
          const id = enumValue(
            args.album,
            albums.filter((a) => !a.rule).map((a) => a.id)
          )
          const remove = organization.targets(photos).every((photo) => photo.albums.includes(id))
          await applySelection((photo) => ({
            albums: remove ? photo.albums.filter((a) => a !== id) : [...new Set([...photo.albums, id])]
          }))
          break
        }
        case 'copy-edits':
          result = organization.copy(p, args.keys)
          break
        case 'paste-edits':
          await applySelection((photo) => ({ edit: organization.pasted(photo) }), true)
          break
        case 'version-save': {
          const version = namedVersion(p, args.name)
          await replace(p, { versions: [...(p.versions ?? []), version] })
          result = version
          break
        }
        case 'version-restore': {
          const version = findVersion(p, args.id)
          await replace(p, { edit: structuredClone(version.edit) })
          undo.push({ id: p.id, edit: p.edit })
          redo.length = 0
          compare = false
          break
        }
        case 'version-rename': {
          const version = findVersion(p, args.id),
            name = String(args.name ?? '').trim()
          if (!name) throw Error('Enter a version name')
          await replace(p, { versions: p.versions.map((v) => (v.id === version.id ? { ...v, name } : v)) })
          break
        }
        case 'version-delete':
          findVersion(p, args.id)
          await replace(p, { versions: p.versions.filter((v) => v.id !== args.id) })
          break
        case 'edit':
        case 'reset': {
          let edit = {}
          if (command === 'edit') {
            const { key, value } = args
            if (Object.hasOwn(groups, key)) number(value, ...groups[key])
            else if (key === 'crop') {
              if (value !== null && !validCrop(value))
                throw Error('Crop rectangle must fit inside the original')
              cropping = false
            } else if (key === 'turn') enumValue(value, [0, 1, 2, 3])
            else if (key === 'flip') enumValue(value, [true, false])
            else if (key === 'aspect') enumValue(value, ['', '1', '1.5', '1.7777777778', '0.8'])
            else throw Error('Unknown edit control')
            edit = { ...p.edit, [key]: value }
          }
          await replace(p, { edit })
          undo.push({ id: p.id, edit: p.edit })
          redo.length = 0
          compare = false
          break
        }
        case 'undo':
        case 'redo': {
          const [from, to] = command === 'undo' ? [undo, redo] : [redo, undo]
          const index = from.findLastIndex((e) => e.id === p.id)
          if (index >= 0) {
            await replace(p, { edit: from[index].edit })
            from.splice(index, 1)
            to.push({ id: p.id, edit: p.edit })
          }
          break
        }
        case 'apply-xmp': {
          const changes = readXmp(args.xml)
          await replace(p, changes)
          if (changes.edit) {
            undo.push({ id: p.id, edit: p.edit })
            redo.length = 0
          }
          break
        }
        case 'video-play':
        case 'video-pause':
        case 'video-seek':
        case 'video-trim': {
          if (!isVideo(p)) throw Error('Select a video')
          mode = 'detail'
          await source(p.id)
          const media = playingMedia
          if (command === 'video-play') {
            const range = clipRange(p.edit.trim, media.duration)
            if (media.video.currentTime < range.start || media.video.currentTime >= range.end)
              await media.seek(range.start)
            media.video.muted = false
            await media.video.play()
            cancelAnimationFrame(frameTicket)
            frameTicket = requestAnimationFrame(refreshPlayback)
          } else if (command === 'video-pause') stopPlayback()
          else if (command === 'video-seek') {
            stopPlayback()
            await media.seek(args.time)
          } else {
            const range = clipRange(args, media.duration)
            stopPlayback()
            await media.seek(range.start)
            await replace(p, { edit: { ...p.edit, trim: range } })
            undo.push({ id: p.id, edit: p.edit })
            redo.length = 0
          }
          break
        }
        case 'remove-mask': {
          const masks = p.edit.localTools?.masks || [],
            mask = args.id ? masks.find((m) => m.id === args.id) : masks.at(-1)
          if (!mask) throw Error('Create a mask for the area to remove')
          const algorithm = enumValue(args.algorithm ?? 'ns', ['ns', 'telea'])
          const edit = await removeMaskedArea(
            await source(p.id),
            p.edit,
            mask,
            algorithm,
            number(args.radius ?? 3, 0.1, 100)
          )
          await replace(p, { edit })
          undo.push({ id: p.id, edit: p.edit })
          redo.length = 0
          break
        }
        case 'preset-save':
          result = await presets.create(args.name, p.edit)
          break
        case 'preset-apply': {
          await replace(p, { edit: { ...p.edit, ...presets.get(args.id).edit } })
          undo.push({ id: p.id, edit: p.edit })
          redo.length = 0
          compare = false
          break
        }
        case 'histogram':
          return histogram(render(await source(p.id), p.edit, 400))
        case 'auto-tone': {
          const exposure = autoExposure(histogram(render(await source(p.id), {}, 400)))
          await replace(p, { edit: { ...p.edit, Exposure: exposure } })
          undo.push({ id: p.id, edit: p.edit })
          redo.length = 0
          break
        }
        case 'sample-color': {
          const canvas = render(await source(p.id), p.edit, 1280)
          return { color: sampleColor(canvas, number(args.x, 0, 1), number(args.y, 0, 1)) }
        }
        case 'point-add':
        case 'point-update':
        case 'point-remove': {
          const points = [...(p.edit.pointColors || [])]
          if (command === 'point-add') {
            const point = validatePoint({
              id: crypto.randomUUID(),
              color: args.color,
              hue: 0,
              saturation: 0,
              luminance: 0,
              range: 15
            })
            points.push(point)
            selectedPoint = point.id
            sampling = false
            result = point
          } else {
            const index = points.findIndex((v) => v.id === args.id)
            if (index < 0) throw Error('Color sample not found')
            if (command === 'point-remove') points.splice(index, 1)
            else points[index] = validatePoint({ ...points[index], ...args })
          }
          await replace(p, { edit: { ...p.edit, pointColors: points } })
          undo.push({ id: p.id, edit: p.edit })
          redo.length = 0
          break
        }
        case 'white-balance': {
          const values = neutralBalance(await source(p.id), number(args.x, 0, 1), number(args.y, 0, 1))
          await replace(p, { edit: { ...p.edit, ...values } })
          undo.push({ id: p.id, edit: p.edit })
          redo.length = 0
          sampling = false
          break
        }
        case 'compare':
          compare = !compare
          pair = sampling = false
          mode = 'detail'
          break
        case 'zoom':
          zoom = !zoom
          mode = 'detail'
          break
        case 'export-hdr': {
          const data = await original(p.id)
          if (!data.radiance) throw Error('The selected photo has no merged HDR radiance')
          return { blob: data.radiance, filename: p.name.replace(/\.[^.]+$/, '') + '.hdr' }
        }
        case 'export':
        case 'preview': {
          const format =
            command === 'preview'
              ? 'image/png'
              : enumValue(args.format ?? (isVideo(p) ? 'video/mp4' : 'image/jpeg'), EXPORT_TYPES)
          if (format.startsWith('video/')) {
            if (!isVideo(p)) throw Error('Select a video')
            await source(p.id)
            return exportVideo((await original(p.id)).file, p, { ...args, format })
          }
          if (format === 'original') return { blob: (await original(p.id)).file, filename: p.name }
          if (format === 'image/x-adobe-dng') {
            if (args.maxSize !== undefined || args.watermark)
              throw Error('DNG preserves RAW pixels; use a rendered format for resizing or watermarks')
            return exportDng(p, (await original(p.id)).file)
          }
          if (format === 'original-settings') return exportPackage(p, (await original(p.id)).file)
          if (format === 'application/rdf+xml')
            return {
              blob: new Blob([exportXmp(p)], { type: format }),
              filename: exportFilename(p.name, format)
            }
          const max =
            args.maxSize === undefined
              ? command === 'preview'
                ? 1280
                : Infinity
              : number(args.maxSize, 1, Number.MAX_SAFE_INTEGER)
          const canvas = render(await source(p.id), command === 'preview' && compare ? {} : p.edit, max)
          if (command === 'export') applyWatermark(canvas, args.watermark)
          return {
            blob: await encodePhoto(canvas, format, number(args.quality ?? 0.92, 0, 1)),
            filename: exportFilename(p.name, format)
          }
        }
        default:
          throw Error('Unknown command: ' + command)
      }
    }
  }
  if (nextId && visible().some((row) => row.id === nextId))
    selected = organization.chooseMany(visible(), [nextId])
  await draw()
  return result ?? snapshot()
}
const ready = Promise.all([db.all('photos'), db.all('albums'), presets.load()]).then(async (values) => {
  ;[photos, albums] = values
  await draw()
})
export function run(command, args = {}, observe) {
  const next = queue
    .then(() => ready)
    .then(async () => {
      validateArgs(command, args)
      const previous = libraryHistory.checkpoint(command, photos, albums, local.state())
      const result = await execute(command, args)
      libraryHistory.record(previous, photos, albums)
      const unchangedPoll = command === 'external-check' && !result.imported?.length
      if (
        !unchangedPoll &&
        !(result?.blob instanceof Blob) &&
        ![
          'state',
          'photos',
          'presets',
          'histogram',
          'local-folders',
          'lens-profiles',
          'lens-match',
          'sample-color',
          'migration-inspect',
          'migration-report'
        ].includes(command)
      ) {
        notifyWorkspaceChange()
      }
      return observe ? observe(result, snapshot()) : result
    })
  queue = next.catch(() => {})
  return next
}
let noticeTimer
function notice(text) {
  clearTimeout(noticeTimer)
  $('notice').textContent = text
  noticeTimer = setTimeout(() => ($('notice').textContent = ''), 7000)
}
function act(cmd, args) {
  return run(cmd, args).catch((e) => notice(e.message))
}
const localToolContainer = document.createElement('div')
$('reset').before(localToolContainer)
localToolsUI = createLocalToolsUI({ container: localToolContainer, run, getActive: active, notify: notice })
async function importUI(files) {
  const result = await act('import', { files: [...files] })
  if (result?.failed.length) notice(result.failed.map((f) => f.name + ': ' + f.error).join(' · '))
  else if (result?.existing.length) notice(result.existing.length + ' already in the library')
}
for (const [group, items] of Object.entries(controls)) {
  const details = document.createElement('details'),
    summary = document.createElement('summary')
  details.open = group === 'Light' || group === 'Color'
  summary.textContent = group
  details.append(summary)
  for (const [key, [min, max, step]] of Object.entries(items)) {
    const label = document.createElement('label'),
      output = document.createElement('output'),
      input = document.createElement('input')
    input.type = 'range'
    input.min = min
    input.max = max
    input.step = step
    input.value = 0
    input.dataset.control = key
    input.setAttribute('aria-label', key)
    input.oninput = () => {
      output.value = input.value
      const id = selected,
        value = Number(input.value)
      cancelAnimationFrame(sliderFrame)
      sliderFrame = requestAnimationFrame(() => {
        if (bitmap && bitmapId === id && selected === id && mode === 'detail') {
          compare = false
          paintStage(bitmap, { ...active().edit, [key]: value })
        }
      })
    }
    input.onchange = () => {
      cancelAnimationFrame(sliderFrame)
      act('edit', { key, value: Number(input.value) })
    }
    label.append(key, output, input)
    details.append(label)
  }
  $('adjustments').append(details)
}
for (let i = 1; i <= 5; i++) $('rate').add(option(i, '★'.repeat(i)))
$('files').accept = PHOTO_ACCEPT + ',video/*,.mov,.mkv,.xmp'
$('apply-xmp').onclick = () => $('xmp-file').click()
$('xmp-file').onchange = async (e) => {
  const file = e.target.files[0]
  if (file) await act('apply-xmp', { xml: await file.text() })
  e.target.value = ''
}
$('crop-tool').onclick = () => act('crop-tool')
$('clear-crop').onclick = () => act('edit', { key: 'crop', value: null })
function notifyWorkspaceChange() {
  window.dispatchEvent(new Event('openlr-change'))
}
const cropSurface = new CropSurface($('stage'), () => act('crop-tool'), notifyWorkspaceChange)
async function choosePhotos() {
  if (!globalThis.mygo?.call) {
    $('files').click()
    return
  }
  try {
    const files = await globalThis.mygo.call('Desktop.ChoosePhotos')
    if (files.length) await importUI(files.map(decodeFile))
  } catch (error) {
    notice(error.message)
  }
}
$('import').onclick = choosePhotos
$('files').onchange = async (e) => {
  await importUI(e.target.files)
  e.target.value = ''
}
document.ondragover = (e) => e.preventDefault()
document.ondrop = (e) => {
  e.preventDefault()
  if (e.dataTransfer.files.length) importUI(e.dataTransfer.files)
}
$('search').oninput = (e) => act('search', { text: e.target.value })
$('order').onchange = (e) => act('sort', { order: e.target.value })
document.querySelector('nav').onclick = (e) => {
  const btn = e.target.closest('[data-scope]')
  if (btn) act('scope', { id: btn.dataset.scope })
}
for (const id of ['gallery', 'film']) {
  $(id).onclick = (e) => {
    const btn = e.target.closest('[data-photo]')
    if (btn) act('select', { id: btn.dataset.photo, toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })
  }
  $(id).ondblclick = (e) => {
    if (e.target.closest('[data-photo]')) act('view', { mode: 'detail' })
  }
}
$('grid').onclick = () => act('view', { mode: 'grid' })
$('detail').onclick = () => act('view', { mode: 'detail' })
$('stage').onclick = (e) => {
  if (opticsUI?.consumeClick()) return
  if (sampling && e.target.tagName === 'CANVAS') {
    const rect = e.target.getBoundingClientRect()
    if (sampling === 'point') {
      act('point-add', {
        color: sampleColor(
          e.target,
          (e.clientX - rect.left) / rect.width,
          (e.clientY - rect.top) / rect.height
        )
      })
      return
    }
    const point = viewToOriginal(
      { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height },
      bitmap,
      active().edit
    )
    if (point) act('white-balance', point)
    else notice('Choose a point inside the corrected source image')
  } else if (!cropping && !pair) act('zoom')
}
$('remove-mask').onclick = () => {
  const id = document.querySelector('[aria-label="Local edit selection"]')?.value
  act('remove-mask', id ? { id } : {})
}
$('sample').onclick = () => act('sample-tool')
$('pair').onclick = () => act('compare-pair')
$('rate').onchange = (e) => act('rate', { value: Number(e.target.value) })
$('flag').onchange = (e) => act('flag', { value: e.target.value })
$('keywords').onchange = (e) => act('keywords', { value: e.target.value })
$('color-label').onchange = (e) => act('label', { value: e.target.value })
$('rename-photo').onchange = (e) => act('rename', { name: e.target.value })
$('capture-time').onchange = (e) => act('capture-time', { time: e.target.value })
$('purge').onclick = () => $('purge-dialog').showModal()
$('purge-dialog').onclose = (e) => {
  if (e.target.returnValue === 'ok') act('purge')
  e.target.returnValue = ''
}
$('delete').onclick = () => act(active()?.deleted ? 'restore' : 'delete')
$('membership').onchange = (e) => act('membership', { album: e.target.value })
$('compare').onclick = () => act('compare')
$('preset-list').onchange = (e) => {
  $('preset-delete').disabled = presets.builtIn(e.target.value)
}
$('preset-apply').onclick = () => act('preset-apply', { id: $('preset-list').value })
$('preset-save').onclick = async () => {
  const preset = await act('preset-save', { name: $('preset-name').value })
  if (preset) {
    $('preset-list').value = preset.id
    $('preset-delete').disabled = false
    $('preset-name').value = ''
  }
}
$('preset-delete').onclick = () => act('preset-delete', { id: $('preset-list').value })
$('auto-tone').onclick = () => act('auto-tone')
$('histogram-panel').ontoggle = () => {
  const canvas = $('stage').querySelector('canvas')
  if ($('histogram-panel').open && canvas) drawHistogram($('histogram'), histogram(canvas))
}
$('reset').onclick = () => act('reset')
for (const [id, delta] of [
  ['left', 3],
  ['right', 1]
])
  $(id).onclick = () => act('edit', { key: 'turn', value: ((active().edit.turn || 0) + delta) % 4 })
$('flip').onclick = () => act('edit', { key: 'flip', value: !active().edit.flip })
$('aspect').onchange = (e) => act('edit', { key: 'aspect', value: e.target.value })
$('new-album').onclick = () => {
  $('album-name').value = ''
  $('album-dialog').showModal()
}
$('album-dialog').onclose = (e) => {
  if (e.target.returnValue === 'ok')
    act('album', { name: $('album-name').value, smart: $('smart-album').checked })
  e.target.returnValue = ''
}
$('export').onclick = () => {
  const video = isVideo(active())
  for (const item of $('format').options)
    item.hidden = item.disabled = item.value.startsWith('video/') && !video
  if (video) $('format').value = 'video/mp4'
  else if ($('format').value.startsWith('video/')) $('format').value = 'image/jpeg'
  $('format').dispatchEvent(new Event('change'))
  $('export-dialog').showModal()
}
$('play-video').onclick = () => act(playingMedia?.video.paused ? 'video-play' : 'video-pause')
$('video-position').onchange = (e) => act('video-seek', { time: Number(e.target.value) })
$('trim-apply').onclick = () =>
  act('video-trim', { start: Number($('trim-start').value), end: Number($('trim-end').value) })
$('format').replaceChildren(...EXPORT_FORMATS.map((format) => option(format.value, format.label)))
$('format').onchange = (e) => {
  const usesQuality = EXPORT_FORMATS.find((format) => format.value === e.target.value)?.quality
  $('quality').disabled = !usesQuality
  $('quality').closest('label').hidden = !usesQuality
  const renderOptions = ![
    'original',
    'original-settings',
    'application/rdf+xml',
    'image/x-adobe-dng'
  ].includes(e.target.value)
  for (const id of ['export-size', 'watermark']) {
    $(id).disabled = !renderOptions
    $(id).closest('label').hidden = !renderOptions
  }
}
$('export-dialog').onclose = async (e) => {
  const accepted = e.target.returnValue === 'ok'
  e.target.returnValue = ''
  if (!accepted) return
  try {
    const options = readExportOptions()
    const { blob, filename } = await run('export', options)
    if (await saveExport(blob, filename)) localStorage.setItem('last-export', JSON.stringify(options))
  } catch (err) {
    notice(err.message)
  }
}
document.onkeydown = (e) => {
  if (document.querySelector('dialog[open]') || e.target.matches('input,select,textarea')) return
  const key = e.key.toLowerCase(),
    mod = e.ctrlKey || e.metaKey
  if (!mod && !preferences.shortcuts && key !== 'escape') return
  if (cropping && key === 'escape') act('crop-cancel')
  else if (cropping && key === 'enter') act('crop-tool')
  else if (cropping && key.startsWith('arrow')) {
    const step = e.shiftKey ? 10 : 1
    act('crop-nudge', {
      dx: key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0,
      dy: key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0
    })
  } else if (mod && key === ',') $('settings').click()
  else if (mod && key === 'a') act('select-all')
  else if (mod && key === 'c') act('copy-edits')
  else if (mod && key === 'v') act('paste-edits')
  else if (mod && key === 'z')
    act(
      mode === 'grid' && !local.state()
        ? e.shiftKey
          ? 'library-redo'
          : 'library-undo'
        : e.shiftKey
          ? 'redo'
          : 'undo'
    )
  else if (mod && key === 'f') $('search').focus()
  else if (mod && e.shiftKey && key === 'i') choosePhotos()
  else if (mod && key === 'e') {
    let previous
    try {
      previous = JSON.parse(localStorage.getItem('last-export'))
    } catch {}
    if (previous)
      run('export', previous)
        .then(({ blob, filename }) => saveExport(blob, filename))
        .catch((err) => notice(err.message))
    else $('export').click()
  } else if (!mod && key === 'e' && e.shiftKey) $('export').click()
  else if (!mod && ['e', 'd', 'g'].includes(key))
    act('view', { mode: key === 'g' ? 'grid' : 'detail', inspector: key !== 'd' })
  else if (!mod && key === 'p') act('panel', { name: e.shiftKey ? 'Presets' : 'photos' })
  else if (!mod && key === 'i') act('panel', { name: 'Info' })
  else if (!mod && key === 'f') act('fullscreen')
  else if (!mod && ['m', 'b', 'l', 'r', 'h'].includes(key))
    act('local-tool', { tool: { m: 'brush', b: 'brush', l: 'linear', r: 'radial', h: 'heal' }[key] })
  else if (!mod && e.shiftKey && key === 'a') act('auto-tone')
  else if (mod && key === '[') $('left').click()
  else if (mod && key === ']') $('right').click()
  else if (!mod && key === 'escape') {
    stopSlides()
    act('view', { mode: 'grid' })
  } else if (!mod && /^Digit[0-5]$/.test(e.code))
    act('rate', { value: Number(e.code.slice(-1)), ...(e.shiftKey ? { advance: true } : {}) })
  else if (!mod && ['z', 'u', 'x'].includes(key))
    act('flag', { value: { z: 'pick', u: '', x: 'reject' }[key], ...(e.shiftKey ? { advance: true } : {}) })
  else if (!mod && key === 'delete') $('delete').click()
  else if (!mod && key === '\\') act('compare')
  else if (!mod && key === 'j') act('clipping')
  else if (!mod && key === 'o') act('mask-overlay')
  else if (!mod && key === 'w') act('sample-tool')
  else if (!mod && key === 'c') act('crop-tool')
  else if (!mod && key === '/') act('film')
  else if (!mod && key === ' ') act('zoom')
  else if (!mod && ['arrowleft', 'arrowright'].includes(key)) {
    const list = visible(),
      i = list.findIndex((p) => p.id === selected) + (key === 'arrowright' ? 1 : -1)
    if (list[i]) act('select', { id: list[i].id })
  } else return
  e.preventDefault()
}
updatePoints = pointPanel(act)
$('clip-indicator').onclick = () => act('clipping')
mountPreferences(act)
mountSync(run, notice)
local.mount((command, args) => act(command, args), notice)
external.mount(
  (command, args) =>
    run(command, args).catch((error) => {
      notice(error.message)
      throw error
    }),
  notice
)
camera.mount(run, notice)
sharing.mount(run, notice)
ready.catch((e) => notice(e.message))
updateOrganization = mountOrganization(act)
updateStacks = stackMenu(act)
$('layout').onclick = () => act('grid-layout', { layout: gridLayout === 'square' ? 'mosaic' : 'square' })
$('end-slides').onclick = () => act('slideshow', { stop: true })
updateMerge = mountMerge(run, notice)
updateEnhance = mountEnhance(run, notice)
opticsUI = mountOptics({ run, getActive: active, notify: notice })
migrationUI = mountMigration({ run, notify: notice })
