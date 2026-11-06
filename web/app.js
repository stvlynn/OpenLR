import { readViewport, moveViewport, VIEWPORT_MESSAGES } from './viewport.js'
import { mountColorGrading } from './color-grading-ui.js'
import {
  colorGradingValue,
  patchColorGrading,
  setColorGrading,
  GRADING_MESSAGES,
  validateColorGradingRecipe
} from './color-grading.js'
import { importBatch } from './import-library.js'
import { ADJUSTMENT_DRAFT_MESSAGES as draftMessages, validateArgs } from './agent-protocol.js'
import { decodeFile } from './transfer.js'
import { decodeEditSource } from './edit-source.js'
import {
  processingVersion,
  neutralRecipe,
  validateProcessVersion,
  PROCESS_MESSAGES
} from './process-version.js'
import { workingFrame } from './working-frames.js'
import { inputPrecisionDescription } from './input-color.js'
import { isVideo, openVideo, clipRange } from './video.js'
import { markVideoSeek } from './video-import-diagnostics.js'
import { PHOTO_ACCEPT, photoPreviewVersions } from './decode.js'
import { whenVisible } from './thumbnail-visibility.js'
import { Presets } from './presets.js'
import { LibraryHistory } from './library-history.js'
import { preferences, setPreferences, mountPreferences, displayName, colorLabels } from './preferences.js'
import { displayedPhotos, findStacks, smartMatch, stackMenu } from './stacks.js'
import { readXmp, XMP_MESSAGES } from './xmp.js'
import { mountSync, synchronize } from './sync.js'
import { metadata, describe } from './metadata.js'
import { readExportOptions } from './export-options.js'
import {
  normalizeExportSettings,
  loadExportSettings,
  saveExportSettings,
  EXPORT_SETTINGS_MESSAGES
} from './export-settings.js'
import { COLOR_SPACES } from './color-spaces.js'
import { EXPORT_METADATA_MESSAGES, exportMetadataPolicies } from './export-metadata.js'
import { OUTPUT_SHARPENING_MESSAGES, outputSharpeningLevels } from './export-sharpening.js'
import { exportColorSpaces, EXPORT_COLOR_MESSAGES } from './export-color.js'
import * as db from './catalog.js'
import * as local from './local.js'
import * as external from './external.js'
import * as camera from './camera.js'
import * as sharing from './sharing.js'
import { geometry, validCrop } from './geometry.js'
import { CropSurface } from './crop-surface.js'
import { CROP_GUIDES, CROP_GUIDE_MESSAGES } from './crop-guides.js'
import { drawHistogram, histogram, autoExposure, HISTOGRAM_MESSAGES } from './histogram.js'
import { controls, renderPrepared as render, renderFramePrepared as renderFrame, toBlob } from './render.js'
import { encodeThumbnail } from './encode.js'
import { saveExport, beginExportFolder } from './desktop.js'
import { preparePhotoExport } from './photo-export.js'
import { exportSelection, BATCH_EXPORT_MESSAGES } from './batch-export.js'
import { ExportProgress, EXPORT_PROGRESS_MESSAGES } from './export-progress.js'
import { getImageWorkerDiagnostics } from './image-worker.js'
import { EXPORT_FORMATS } from './formats.js'
import { Organization, namedVersion, findVersion, PURGE_MESSAGES, assertSelection } from './organization.js'
import { validateSmartRule, sameSmartRule, SMART_ALBUM_MESSAGES } from './smart-album-rule.js'
import { mountOrganization } from './organization-ui.js'
import { COPY_MESSAGES } from './copy-options.js'
import { curvePoints, setToneCurve, validateToneCurveRecipe, CURVE_MESSAGES } from './tone-curves.js'
import { mountToneCurves } from './tone-curves-ui.js'
import { mergePhotos } from './merge.js'
import { mountMerge } from './merge-ui.js'
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
import { LOCAL_COMMANDS, updateLocalTools, localToolAt, validateLocalTool } from './local-tools.js'
import { createLocalToolsUI, viewToOriginal } from './local-tools-ui.js'
import { neutralBalance, WHITE_BALANCE_MESSAGES } from './white-balance.js'
import { analyzeFocus, validEye } from './culling.js'
import {
  validatePoint,
  pointPanel,
  sampleColor,
  sampleSourceColor,
  clippingOverlay,
  POINT_COLOR_MESSAGES
} from './point-color.js'
import { removeMaskedArea } from './remove-mask.js'
import { generateAiMask } from './ai-mask.js'
import { estimateDepth } from './depth.js'
import { validateDepthSettings } from './depth-effects.js'
import { renderMaskPreview } from './mask-preview.js'
import { enhancePhoto } from './enhance.js'
import { mountEnhance } from './enhance-ui.js'

const $ = (id) => document.getElementById(id)
const option = (value, label) => new Option(label, value)
const scrollports = {
  detail: $('stage'),
  grid: $('gallery'),
  filmstrip: $('film'),
  photos: document.querySelector('main > nav'),
  inspector: document.querySelector('main > aside')
}
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
  bitmapVersion = 1,
  queue = Promise.resolve()
const urls = new Map(),
  undo = [],
  redo = []
const organization = new Organization()
let historyOrder = 0
const nextHistoryOrder = () => ++historyOrder
const libraryHistory = new LibraryHistory(nextHistoryOrder)
function rememberEdit(photo) {
  undo.push({ id: photo.id, edit: photo.edit, order: nextHistoryOrder() })
}
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
  selectedPoint = '',
  pointPhoto = ''
let updatePoints = () => {}
let curveChannel = 'rgb',
  curveIndex = 0,
  curvePhoto = ''
let updateToneCurves = () => {}
let gradingMode = 'three',
  updateColorGrading = () => {}
let playingMedia = null,
  playbackFrames = null,
  playbackGeneration = 0,
  frameTicket = 0
function cancelPlaybackFrames() {
  playbackGeneration++
  cancelAnimationFrame(frameTicket)
  playbackFrames?.close()
  playbackFrames = null
}
function stopPlayback() {
  playingMedia?.video.pause()
  cancelPlaybackFrames()
}
async function refreshPlayback() {
  const media = playingMedia,
    photo = active()
  if (!media || !photo || bitmapId !== photo.id || mode !== 'detail') return
  const { video, duration } = media,
    time = video.currentTime,
    end = video.paused || time >= clipRange(photo.edit.trim, duration).end
  if (end) cancelPlaybackFrames()
  const generation = playbackGeneration,
    cursor = playbackFrames
  const ownsPlayback = () =>
    playingMedia === media && playbackGeneration === generation && selected === photo.id && mode === 'detail'
  const ownsFrame = () => ownsPlayback() && active() === photo
  try {
    const pending = end ? media.pauseFrame(ownsPlayback) : cursor ? cursor.at(time) : media.frameAt(time)
    $('play-video').textContent = video.paused ? 'Play' : 'Pause'
    $('video-position').value = time
    const image = await pending
    if (end && ownsPlayback()) $('video-position').value = video.currentTime
    if (image && ownsFrame()) {
      bitmap = image
      await previewStage(image, photo.edit, ownsFrame)
    }
  } catch (error) {
    if (!ownsPlayback()) return
    stopPlayback()
    $('play-video').textContent = 'Play'
    notice(error.message)
  }
  if (ownsPlayback() && !video.paused) frameTicket = requestAnimationFrame(refreshPlayback)
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
async function source(id, recipe = photos.find((photo) => photo.id === id)?.edit ?? {}, seekTrace) {
  const selectedPhoto = photos.find((photo) => photo.id === id)
  if (selectedPhoto?.local?.sidecarError) throw new Error(selectedPhoto.local.sidecarError)
  const version = processingVersion(recipe)
  if (bitmapId !== id || bitmapVersion !== version) {
    markVideoSeek(seekTrace, 'source-original')
    const data = await original(id)
    markVideoSeek(seekTrace, 'source-original-read')
    const photo = photos.find((p) => p.id === id)
    const video = isVideo(data.file)
    if (video && version === 2) throw new Error(PROCESS_MESSAGES.video)
    let media, next
    try {
      if (video) {
        media = await openVideo(data.file, undefined, seekTrace)
        markVideoSeek(seekTrace, 'playback-opened', media.video)
        await media.seek(clipRange(photo.edit.trim, media.duration).start, false, seekTrace)
        markVideoSeek(seekTrace, 'source-frame', media.video)
        next = await media.frameAt()
        markVideoSeek(seekTrace, 'source-frame-read', media.video)
      } else next = await decodeEditSource(data.file, recipe)
      if (photo) {
        photo.metadata ??= await metadata(data.file)
        if (media) photo.duration = media.duration
        photo.width = next.width
        photo.height = next.height
      }
    } catch (error) {
      media?.close()
      next?.close?.()
      throw error
    }
    stopPlayback()
    playingMedia?.close()
    playingMedia = media ?? null
    localToolsUI?.unmount()
    opticsUI?.unmount()
    cancelPaint()
    bitmap?.close?.()
    bitmap = next
    bitmapId = id
    bitmapVersion = version
  } else if (playingMedia) {
    const media = playingMedia,
      image = await media.frameAt()
    if (playingMedia === media && selected === id) bitmap = image
    return image
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
  cancelPaint()
  for (const observer of thumbnailObservers) observer.disconnect()
  thumbnailObservers.clear()
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
const thumbnailJobs = new WeakMap(),
  thumbnailTargets = new WeakMap(),
  thumbnailObservers = new Set()
function refreshThumbnail(photo, img) {
  const versions = photoPreviewVersions(photo)
  if (photo.local || Object.entries(versions).every(([key, version]) => photo[key] === version)) return
  const previous = thumbnailTargets.get(img)
  if (previous?.photo === photo) return
  previous?.observer?.disconnect()
  thumbnailObservers.delete(previous?.observer)
  const observer = whenVisible(
    img,
    async () => {
      if (!img.isConnected || !photos.includes(photo)) return
      if (!thumbnailJobs.has(photo)) {
        // Cache writes share the command queue, but do not create edit history.
        const job = queue
          .then(() => ready)
          .then(async () => {
            if (!photos.includes(photo)) return
            let image
            try {
              image = await decodeEditSource((await original(photo.id)).file, photo.edit)
              const cache = {
                thumbnail: encodeThumbnail(await render(image, photo.edit, 240)),
                width: image.width,
                height: image.height,
                ...versions
              }
              // Replaced rows represent newer edits or another library; never overwrite them.
              if (!photos.includes(photo)) return
              await db.save('photos', { ...photo, ...cache })
              Object.assign(photo, cache)
              invalidate(photo.id)
            } finally {
              image?.close()
            }
          })
        thumbnailJobs.set(photo, job)
        queue = job.catch(() => {})
      }
      try {
        await thumbnailJobs.get(photo)
        if (img.isConnected && photos.includes(photo)) {
          img.src = thumb(photo)
          img.parentElement.style.setProperty('--aspect', photo.width / photo.height)
        }
      } catch (error) {
        img.title = error.message
        notice(photo.name + ': ' + error.message)
      }
    },
    (finished) => thumbnailObservers.delete(finished)
  )
  if (observer) thumbnailObservers.add(observer)
  thumbnailTargets.set(img, { photo, observer })
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
  refreshThumbnail(photo, img)
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
      node.style.setProperty('--aspect', p.width && p.height ? p.width / p.height : 1)
      node.setAttribute('aria-pressed', organization.selection.has(p.id))
      if (node.firstChild.src !== url) node.firstChild.src = url
      refreshThumbnail(p, node.firstChild)
    })
  }
}
let paintController = null,
  paintRevision = 0,
  samplePreview = null,
  histogramPreview = null,
  adjustmentDraft = null,
  adjustmentFrame = 0

function adjustmentDraftState() {
  return adjustmentDraft && ownsAdjustment(adjustmentDraft) ? structuredClone(adjustmentDraft.state) : null
}
function syncCompareControl() {
  $('compare').setAttribute('aria-pressed', compare)
}
function discardAdjustmentDraft(keepRender = false) {
  const record = adjustmentDraft
  if (!record) return null
  adjustmentDraft = null
  cancelAnimationFrame(adjustmentFrame)
  if (!keepRender) cancelPaint()
  return record
}
function stageAdjustment(command, photo, args, edit, context) {
  const { draftSource, draftEdit } = context
  if (draftSource && (draftSource.canceled || photo.edit !== draftEdit)) return null
  if (
    mode !== 'detail' ||
    !bitmap ||
    bitmapId !== photo.id ||
    bitmapVersion !== processingVersion(photo.edit) ||
    (playingMedia && !playingMedia.video.paused)
  ) {
    if (draftSource) return null
    throw Error(draftMessages.detail)
  }
  const { draft: _, ...change } = args
  const state = {
    id: crypto.randomUUID(),
    photoId: photo.id,
    command,
    args: structuredClone({ ...change, photoId: photo.id }),
    status: 'pending'
  }
  const record = { state, source: draftSource, owner: photo.edit, image: bitmap }
  if (adjustmentDraft?.source !== draftSource) adjustmentDraft?.source?.cancel()
  adjustmentDraft = record
  compare = false
  syncCompareControl()
  cancelAnimationFrame(adjustmentFrame)
  adjustmentFrame = requestAnimationFrame(async () => {
    if (!ownsAdjustment(record)) return
    try {
      const canvas = await paintStage(record.image, edit, () => ownsAdjustment(record))
      if (!canvas || !ownsAdjustment(record)) return
      state.status = 'ready'
      record.canvas = canvas
    } catch (error) {
      if (!ownsAdjustment(record)) return
      state.status = 'failed'
      state.error = error.message
      if (draftSource) notice(error.message)
    }
    notifyWorkspaceChange()
  })
  return adjustmentDraftState()
}
function ownsAdjustment(record) {
  return (
    adjustmentDraft === record &&
    selected === record.state.photoId &&
    active()?.edit === record.owner &&
    bitmap === record.image &&
    mode === 'detail' &&
    !(playingMedia && !playingMedia.video.paused)
  )
}
function adjustmentPanel() {
  const draft = adjustmentDraft?.state
  if (draft?.command === 'curve-set') return $('tone-curves')
  if (draft?.command === 'grading-set') return $('color-grading')
  if (draft?.command === 'edit')
    return document.querySelector(`[data-control="${CSS.escape(draft.args.key)}"]`)?.closest('details')
  return null
}
function currentAdjustment(id) {
  const record = adjustmentDraft
  if (!record || record.state.id !== id || !ownsAdjustment(record)) throw Error(draftMessages.changed)
  return record
}
async function draftImage(id) {
  const record = currentAdjustment(id)
  const canvas = record.canvas
  if (
    record.state.status !== 'ready' ||
    histogramPreview?.canvas !== canvas ||
    canvas?.parentElement !== $('stage')
  )
    throw Error(record.state.error ?? draftMessages.pending)
  const blob = await toBlob(canvas, 'image/png')
  if (
    currentAdjustment(id) !== record ||
    histogramPreview?.canvas !== canvas ||
    canvas.parentElement !== $('stage')
  )
    throw Error(draftMessages.changed)
  return { blob, filename: 'adjustment-draft.png' }
}
function cancelPaint() {
  paintRevision++
  paintController?.abort()
  paintController = null
  samplePreview = null
  histogramPreview = null
}
function displayedHistogram() {
  const preview = histogramPreview
  if (
    mode !== 'detail' ||
    preview?.photoId !== selected ||
    preview.canvas.parentElement !== $('stage') ||
    $('stage').hidden
  )
    return null
  return (preview.bins ??= histogram(preview.canvas))
}
async function previewStage(image, edit, isCurrent) {
  try {
    await paintStage(image, edit, isCurrent)
  } catch (error) {
    if (error.name !== 'AbortError') notice(error.message)
  }
}
async function paintStage(image, edit, isCurrent = () => true) {
  const previous = paintController,
    controller = new AbortController()
  paintController = controller
  const revision = ++paintRevision
  const photoId = selected,
    owner = active()?.edit,
    sourceMatchesPhoto = bitmapId === photoId && image === bitmap

  const recipe = cropping
    ? { ...edit, crop: null, aspect: '', turn: 0, flip: false }
    : compare
      ? neutralRecipe(edit)
      : edit
  const stage = $('stage'),
    shape = geometry(image, recipe)
  const w = shape.turn % 2 ? shape.height : shape.width,
    h = shape.turn % 2 ? shape.width : shape.height
  const fit = Math.min((stage.clientWidth - 24) / w, (stage.clientHeight - 24) / h) * devicePixelRatio
  const edge = zoom ? Infinity : Math.max(1, Math.round(Math.max(w, h) * fit))
  // Join the next preparation before releasing the superseded preview so a
  // slider does not repeatedly restart identical source analysis.
  const pending = render(image, recipe, edge, { signal: controller.signal })
  previous?.abort()
  let preview
  try {
    preview = await pending
  } catch (error) {
    if (error.name === 'AbortError') return
    throw error
  }
  if (
    paintRevision !== revision ||
    paintController !== controller ||
    controller.signal.aborted ||
    !isCurrent() ||
    selected !== photoId ||
    active()?.edit !== owner ||
    mode !== 'detail'
  )
    return
  const originalPreview = pair ? await render(image, neutralRecipe(edit), edge) : null
  if (
    paintRevision !== revision ||
    paintController !== controller ||
    controller.signal.aborted ||
    !isCurrent() ||
    selected !== photoId ||
    active()?.edit !== owner ||
    mode !== 'detail'
  )
    return
  samplePreview = null
  stage.classList.toggle('pair', pair)
  if (pair) stage.replaceChildren(originalPreview, preview)
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
  // Warnings paint into the preview canvas; retain its photo bins first.
  // An unopened histogram needs no readback when warnings are off.
  histogramPreview = { photoId, canvas: preview, bins: clipping ? histogram(preview) : null }
  if ($('histogram-panel').open) drawHistogram($('histogram'), displayedHistogram())
  if (clipping) clippingOverlay(preview)
  $('stage').classList.toggle('cropping', cropping)
  $('stage').classList.toggle('zoom', zoom)
  if (sourceMatchesPhoto && recipe === owner && !cropping && !compare && !pair)
    samplePreview = { canvas: preview, image, photoId, edit: owner }
  return preview
}
function displayedSamplePreview(photo, clickedCanvas, messages) {
  if (clickedCanvas !== undefined && clickedCanvas !== samplePreview?.canvas)
    throw Error(messages.changedPreview)
  const stage = $('stage')
  if (
    samplePreview?.photoId !== photo.id ||
    samplePreview.edit !== photo.edit ||
    samplePreview.canvas.parentElement !== stage ||
    stage.hidden
  )
    throw Error(messages.preview)
  return samplePreview
}
async function draw(pausedFrame, seekTrace) {
  local.drawNavigation()
  const list = visible()
  selected = organization.reconcile(list, selected)
  if (!selected) mode = 'grid'
  if (mode === 'grid') stopSlides()
  const p = active(),
    detail = mode === 'detail'
  const draft = discardAdjustmentDraft()
  if (draft && (draft.state.photoId !== selected || !detail || draft.owner === p?.edit))
    draft.source?.cancel()
  paintRevision++
  if (!detail || bitmapId !== selected) {
    cancelPaint()
    if (playingMedia) stopPlayback()
  }
  const curveSource = p?.local?.sidecarError ? null : p
  const points = p?.edit.pointColors ?? []
  if (pointPhoto !== (p?.id ?? '') || !points.some((point) => point.id === selectedPoint))
    selectedPoint = points[0]?.id ?? ''
  pointPhoto = p?.id ?? ''
  updatePoints(points, selectedPoint, pointPhoto)
  if (curvePhoto !== (p?.id ?? '')) curveIndex = 0
  curvePhoto = p?.id ?? ''
  curveIndex = Math.min(curveIndex, curvePoints(curveSource?.edit ?? {}, curveChannel).length - 1)
  updateColorGrading(detail && inspector && !p?.deleted ? curveSource : null, { mode: gradingMode })
  updateToneCurves(curveSource, { channel: curveChannel, index: curveIndex })
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
  scrollports.inspector.hidden = !detail || !inspector || p?.deleted
  $('actions').hidden = !p
  $('export').textContent = BATCH_EXPORT_MESSAGES.action(organization.selection.size)
  $('export').disabled = !p
  $('export-previous').disabled = !p
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
  $('processing-version').value = String(processingVersion(p?.edit))
  $('processing-version').disabled = !p || Boolean(p.duration)
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
  syncCompareControl()
  $('pair').setAttribute('aria-pressed', pair)
  $('sample').setAttribute('aria-pressed', sampling === 'white')
  $('remove-mask').disabled = !p.edit.localTools?.masks?.length
  $('clip-indicator').setAttribute('aria-pressed', clipping)
  $('aspect').value = p.edit.aspect || ''
  $('crop-tool').textContent = cropping ? 'Done' : 'Crop area'
  updateCropGuideControls()
  for (const input of document.querySelectorAll('[data-control]')) {
    input.value = p.edit[input.dataset.control] || 0
    input.previousElementSibling.value = input.value
  }
  if (detail) {
    const currentMedia = playingMedia && bitmapId === p.id
    markVideoSeek(seekTrace, 'stage-frame', playingMedia?.video)
    let image
    if (currentMedia && pausedFrame?.media === playingMedia && pausedFrame.image) {
      image = bitmap = pausedFrame.image
    } else image = currentMedia && !playingMedia.video.paused ? bitmap : await source(p.id)
    markVideoSeek(seekTrace, 'stage-paint', playingMedia?.video)
    await paintStage(image, p.edit)
    markVideoSeek(seekTrace, 'stage-painted', playingMedia?.video)
  }
  const precision = inputPrecisionDescription(processingState(p)?.input)
  if (precision) $('info').textContent += '\n' + precision
  const video = detail && isVideo(p) && playingMedia
  $('video-bar').hidden = !video
  if (video) {
    const range = clipRange(p.edit.trim, video.duration)
    $('video-position').max = video.duration
    $('video-position').value = video.video.currentTime
    $('trim-start').value = range.start
    $('trim-end').value = Number(range.end.toFixed(3))
    $('video-bar').dataset.photoId = p.id
    $('play-video').textContent = video.video.paused ? 'Play' : 'Pause'
  }
}
function cropDraft() {
  return cropping && cropSurface.owner === selected ? { ...cropSurface.box } : null
}
function processingState(photo = active()) {
  if (!photo) return null
  const version = processingVersion(photo.edit)
  const provenance =
    bitmapId === photo.id && bitmapVersion === version ? workingFrame(bitmap)?.provenance : null
  return { version, input: provenance ? { ...provenance } : null }
}
function panelSnapshot() {
  return Object.fromEntries(
    [...panels].map(([name, panel]) => [
      name,
      panel instanceof HTMLDetailsElement ? panel.open : !panel.hidden
    ])
  )
}
function viewportElement(target, photo) {
  const element = scrollports[target]
  if (target === 'photos' || target === 'inspector')
    return !element.hidden && slideTimer === null ? element : null
  const visible =
    target === 'grid'
      ? mode === 'grid'
      : mode === 'detail' && photo && (target === 'detail' || (film && slideTimer === null))
  return visible ? element : null
}
function viewportSnapshot(photo) {
  const read = (target) => {
    const element = viewportElement(target, photo)
    return element && readViewport(element)
  }
  return {
    viewport: read('detail'),
    catalogViewports: { grid: read('grid'), filmstrip: read('filmstrip') },
    panelViewports: { photos: read('photos'), inspector: read('inspector') }
  }
}
function snapshot() {
  const items = visible().map(({ thumbnail, ...p }) => p)
  // Retain expansion choices for history, but report only stacks in the current catalog.
  const stackIds = openStacks.size ? new Set(photos.map((photo) => photo.stackId)) : null
  return {
    openStacks: [...openStacks].filter((id) => stackIds?.has(id)),
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
    processing: processingState(),
    selected,
    scope,
    mode,
    inspector,
    panels: panelSnapshot(),
    search,
    order,
    compare,
    clipping,
    pair,
    sampling,
    cropping,
    cropDraft: cropDraft(),
    adjustmentDraft: adjustmentDraftState(),
    localDraft: localToolsUI?.draftState() ?? null,
    cropGuide: { ...cropSurface.guide },
    straightenTool: opticsUI?.snapshot(),
    localSelection: localToolsUI?.selection(),
    localTool: localToolsUI?.getMode() ?? 'off',
    repairSource: localToolsUI?.repairSource(),
    rangeColor: localToolsUI?.rangeColor() ?? '#808080',
    selectedPoint,
    toneCurve: { channel: curveChannel, index: curveIndex },
    colorGrading: { mode: gradingMode },
    film,
    zoom,
    ...viewportSnapshot(active()),
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
        rememberEdit(photo)
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
  if (changes.edit) {
    const image = await source(p.id, changes.edit)
    next.thumbnail = encodeThumbnail(await render(image, changes.edit, 240))
    next.width = image.width
    next.height = image.height
    Object.assign(next, photoPreviewVersions(p))
  }
  return next
}
async function replace(p, changes) {
  if (changes.edit) {
    validateToneCurveRecipe(changes.edit)
    validateColorGradingRecipe(changes.edit)
  }
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
        rememberEdit(p)
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
      if (recordUndo) rememberEdit(photo)
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
const exportProgress = new ExportProgress((job) => {
  updateExportProgress(job)
  notifyWorkspaceChange()
})
async function execute(command, args, context = {}) {
  const p = active()
  if (args.expectedIds !== undefined && command !== 'purge')
    assertSelection(organization.targets(photos), args.expectedIds)
  if (context.draftSource?.canceled && command !== 'draft-cancel') return null
  if (args.draft && context.draftSource && (!p || p.edit !== context.draftEdit || p.id !== args.photoId))
    return null
  if (command === 'draft-commit') {
    if (localToolsUI?.hasDraftId(args.id)) {
      const draft = localToolsUI.takeDraft(args.id)
      try {
        return await execute(draft.command, draft.args)
      } catch (error) {
        notifyWorkspaceChange()
        throw error
      }
    }
    const record = currentAdjustment(args.id)
    if (record.state.status === 'failed') throw Error(record.state.error)
    record.source?.cancel()
    discardAdjustmentDraft(true)
    try {
      return await execute(record.state.command, record.state.args)
    } catch (error) {
      if (active()?.edit === record.owner && bitmap === record.image)
        await previewStage(record.image, record.owner)
      notifyWorkspaceChange()
      throw error
    }
  }
  if (
    [
      'view',
      'local-tool',
      'crop-tool',
      'sample-tool',
      'point-tool',
      'compare',
      'compare-pair',
      'scope',
      'library',
      'local-open',
      'local-browse'
    ].includes(command)
  )
    opticsUI?.deactivate()
  let result, pausedFrame
  const advance =
    (command === 'rate' || command === 'flag') &&
    (args.advance ?? preferences.autoAdvance) &&
    organization.selection.size === 1
  const nextId = advance ? visible()[visible().findIndex((row) => row.id === selected) + 1]?.id : null
  switch (command) {
    case 'draft-cancel': {
      if (!context.draftSource && localToolsUI?.hasDraftId(args.id)) {
        localToolsUI.takeDraft(args.id)
        return { canceled: true }
      }
      if (context.draftSource) {
        if (adjustmentDraft?.source !== context.draftSource) return { canceled: false }
      } else currentAdjustment(args.id)
      discardAdjustmentDraft()?.source?.cancel()
      await draw()
      return { canceled: true }
    }
    case 'viewport': {
      if (args.photoId !== undefined && args.photoId !== p?.id) throw Error(VIEWPORT_MESSAGES.changed)
      const target = args.target ?? 'detail'
      const element = viewportElement(target, p)
      if (!element) throw Error(VIEWPORT_MESSAGES[target])
      if (args.x === undefined && args.y === undefined) return readViewport(element)
      return moveViewport(element, args)
    }
    case 'export-selection':
      return exportSelection({
        visible: visible(),
        selection: organization.selection,
        args,
        original,
        prepare: preparePhotoExport,
        reservedFolder: context.exportSink,
        progress: exportProgress,
        openFolder: () => beginExportFolder(args.outputDirectory)
      })
    case 'export-settings':
      return args.options === undefined ? loadExportSettings() : saveExportSettings(args)
    case 'history-undo':
    case 'history-redo': {
      const backwards = command === 'history-undo',
        editStep = (backwards ? undo : redo).findLast((entry) => entry.id === p?.id),
        libraryStep =
          mode === 'grid' && !local.state()
            ? (backwards ? libraryHistory.undo : libraryHistory.redo).at(-1)
            : null
      if (!editStep && !libraryStep) break
      const library = libraryStep && (!editStep || libraryStep.order > editStep.order)
      return execute(
        library ? (backwards ? 'library-undo' : 'library-redo') : backwards ? 'undo' : 'redo',
        {}
      )
    }
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
        panels: panelSnapshot(),
        visibleCount: visible().length,
        clipping,
        ...viewportSnapshot(photo),
        selectionCount: organization.selection.size,
        processing: processingState(),
        cropDraft: cropDraft(),
        adjustmentDraft: adjustmentDraftState(),
        localDraft: localToolsUI?.draftState() ?? null,
        cropGuide: { ...cropSurface.guide },
        straightenTool: opticsUI?.snapshot(),
        localSelection: localToolsUI?.selection(),
        localTool: localToolsUI?.getMode() ?? 'off',
        repairSource: localToolsUI?.repairSource(),
        rangeColor: localToolsUI?.rangeColor() ?? '#808080',
        selectedPoint,
        toneCurve: { channel: curveChannel, index: curveIndex },
        colorGrading: { mode: gradingMode },
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
      gridLayout = enumValue(args.layout ?? (gridLayout === 'square' ? 'mosaic' : 'square'), [
        'square',
        'mosaic'
      ])
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
      if (bitmapId !== p.id) await source(p.id)
      const { time, image } = await playingMedia.snapshot()
      let blob
      try {
        blob = await toBlob(await render(image, p.edit), 'image/png')
      } finally {
        image.close?.()
      }
      const file = new File([blob], p.name.replace(/\.[^.]+$/, '') + '-' + Math.round(time * 1000) + '.png', {
        type: 'image/png'
      })
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
      if (args.photoId !== undefined && args.photoId !== p?.id) throw Error('The selected photo changed')
      if (args.axis === 'off') {
        if (args.referenceId !== undefined) opticsUI.requireReference(p?.edit, args.referenceId)
        opticsUI.deactivate()
        break
      }
      if (!p || isVideo(p)) throw Error('Select a photo to straighten')
      mode = 'detail'
      inspector = true
      compare = cropping = pair = sampling = false
      localToolsUI.deactivate()
      opticsUI.setMode(enumValue(args.axis ?? 'horizontal', ['horizontal', 'vertical']))
      break
    }
    case 'straighten-point': {
      if (args.photoId !== undefined && args.photoId !== p?.id) throw Error('The selected photo changed')
      const line = opticsUI.placePoint(args.point, p?.edit, args.referenceId, context.straightenOwner)
      return line ? execute('straighten', { ...line, photoId: p.id }) : snapshot()
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
    case 'select-relative': {
      const list = visible()
      let target = args
      if (command === 'select-relative') {
        const index = list.findIndex((photo) => photo.id === selected)
        const next = list[index + (args.direction === 'next' ? 1 : -1)]
        if (!next) return snapshot()
        target = { id: next.id }
      }
      opticsUI?.deactivate()
      selected = organization.choose(list, selected, target)
      compare = zoom = false
      break
    }
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
        ...photoPreviewVersions(file),
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
        ...photoPreviewVersions(merged.file),
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
    case 'local-cancel': {
      if (args.photoId !== undefined && args.photoId !== p?.id) throw Error('The selected photo changed')
      return { canceled: localToolsUI.cancelGesture() }
    }
    case 'repair-source': {
      if (args.photoId !== undefined && args.photoId !== p?.id) throw Error('The selected photo changed')
      if (args.point === undefined && args.picking === undefined) return localToolsUI.repairSource()
      if (!p) throw Error('Select a photo first')
      return localToolsUI.setRepairSource(args)
    }
    case 'local-tool': {
      if (!p) throw Error('Select a photo first')
      if (args.photoId !== undefined && args.photoId !== p.id) throw Error('The selected photo changed')
      mode = 'detail'
      inspector = true
      pair = sampling = compare = cropping = false
      localToolsUI.setMode(
        enumValue(args.tool, ['off', 'brush', 'linear', 'radial', 'clone', 'heal', 'color-sample'])
      )
      opticsUI?.deactivate()
      break
    }
    case 'panel': {
      const panel = panels.get(args.name)
      if (!panel) throw Error('Unknown panel')
      if (!(panel instanceof HTMLDetailsElement)) {
        const hidden = args.open === undefined ? !panel.hidden : !args.open
        if (panel.hidden !== hidden) {
          panel.hidden = hidden
          if (mode === 'detail' && p) {
            if (adjustmentDraft) await draw()
            else await paintStage(await source(p.id), p.edit)
          }
        }
        return snapshot()
      }
      const open = args.open ?? !panel.open
      if (panel.open && !open && panel.parentElement === localToolContainer) localToolsUI.cancelGesture()
      const cancelsAdjustment = panel.open && !open && adjustmentPanel() === panel
      panel.open = open
      if (cancelsAdjustment) await draw()
      if (!context.panelSummary && panel.closest('aside')) {
        if (mode !== 'detail' || !inspector) {
          mode = 'detail'
          inspector = true
          await draw()
        }
        if (open) panel.scrollIntoView({ block: 'nearest' })
      }
      return snapshot()
    }
    case 'fullscreen': {
      if (globalThis.mygo?.call) await globalThis.mygo.call('Desktop.ToggleFullscreen')
      else if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
      break
    }
    case 'crop-guide':
      cropSurface.setGuide({
        type: args.type,
        orientation: args.orientation ?? cropSurface.guide.orientation
      })
      updateCropGuideControls()
      return { cropGuide: { ...cropSurface.guide } }
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
        rememberEdit(p)
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
        ...(args.smart ? { rule: validateSmartRule({ ...organization.filters, text: search }) } : {})
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
    case 'album-rule': {
      if (local.state()) throw Error(SMART_ALBUM_MESSAGES.local)
      const album = albums.find((item) => item.id === args.id)
      if (!album) throw Error(SMART_ALBUM_MESSAGES.notFound)
      if (!album.rule) throw Error(SMART_ALBUM_MESSAGES.notSmart)
      const rule = validateSmartRule(args.rule)
      if (sameSmartRule(album.rule, rule)) {
        result = album
        break
      }
      const next = { ...album, rule }
      await db.save('albums', next)
      albums[albums.indexOf(album)] = next
      result = next
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
      if ((command.startsWith('curve-') || command.startsWith('grading-')) && p.local?.sidecarError)
        throw Error(p.local.sidecarError)
      if (LOCAL_COMMANDS.includes(command)) {
        if (context.localGesture && !localToolsUI.ownsGesture(context.localGesture)) return null
        if (args.photoId !== undefined && args.photoId !== p.id)
          throw Error('The selected photo changed; local edit was canceled')
        if (args.draft) {
          const kind = command.split('.')[0]
          return localToolsUI.stageDraft(
            command,
            args,
            validateLocalTool(kind, args[kind]),
            context.localGesture
          )
        }
        const edit = updateLocalTools(p.edit, command, args)
        await replace(p, { edit })
        rememberEdit(p)
        redo.length = 0
        compare = cropping = false
        await draw()
        if (command === 'mask.add' || command === 'mask.combine')
          localToolsUI.selectMask(command === 'mask.add' ? edit.localTools.masks.at(-1).id : args.id)
        else if (command === 'repair.add') localToolsUI.select(edit.localTools.repairs.at(-1).id)
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
          if (command === 'straighten') opticsUI.deactivate()
          rememberEdit(p)
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
          rememberEdit(p)
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
          rememberEdit(p)
          redo.length = 0
          compare = cropping = false
          await draw()
          localToolsUI.selectMask(edit.localTools.masks.at(-1).id, { finishDrawing: true })
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
            rememberEdit(p)
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
          if (args.photoId !== undefined && args.photoId !== p.id) throw Error('The selected photo changed')
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
          assertSelection(targets, args.expectedIds, PURGE_MESSAGES.changedSelection)
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
          if (args.photoId !== undefined && args.photoId !== p?.id) throw Error(COPY_MESSAGES.changedPhoto)
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
          rememberEdit(p)
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
        case 'processing': {
          if (args.photoId !== undefined && args.photoId !== p.id) throw Error('The selected photo changed')
          const version = validateProcessVersion(args.version)
          if (version === processingVersion(p.edit)) break
          await replace(p, { edit: { ...p.edit, processVersion: version } })
          rememberEdit(p)
          redo.length = 0
          compare = false
          break
        }
        case 'rotate':
        case 'flip':
        case 'edit':
        case 'reset': {
          if (args.photoId !== undefined && args.photoId !== p.id) throw Error('The selected photo changed')
          let edit
          if (command === 'rotate' || command === 'flip') {
            edit =
              command === 'rotate'
                ? { ...p.edit, turn: ((p.edit.turn ?? 0) + (args.direction === 'left' ? 3 : 1)) % 4 }
                : { ...p.edit, flip: !p.edit.flip }
          } else if (command === 'edit') {
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
          } else edit = neutralRecipe(p.edit)
          if (args.draft) return stageAdjustment(command, p, args, edit, context)
          await replace(p, { edit })
          rememberEdit(p)
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
            to.push({ id: p.id, edit: p.edit, order: nextHistoryOrder() })
          }
          break
        }
        case 'apply-xmp': {
          if (args.photoId !== undefined && args.photoId !== p.id) throw Error(XMP_MESSAGES.changedPhoto)
          if (context.expectedEdit !== undefined && context.expectedEdit !== p.edit)
            throw Error(XMP_MESSAGES.changedEdit)
          const changes = readXmp(args.xml)
          await replace(p, changes)
          if (changes.edit) {
            rememberEdit(p)
            redo.length = 0
          }
          break
        }
        case 'video-play':
        case 'video-pause':
        case 'video-toggle':
        case 'video-seek':
        case 'video-trim': {
          if (args.photoId !== undefined && args.photoId !== p.id) throw Error('The selected photo changed')
          if (!isVideo(p)) throw Error('Select a video')
          mode = 'detail'
          if (bitmapId !== p.id) await source(p.id, p.edit, context.seekTrace)
          const media = playingMedia
          if (command === 'video-play' || (command === 'video-toggle' && media.video.paused)) {
            const range = clipRange(p.edit.trim, media.duration)
            if (media.video.currentTime < range.start || media.video.currentTime >= range.end)
              await media.seek(range.start)
            cancelPlaybackFrames()
            media.video.muted = false
            await media.video.play()
            playbackFrames = await media.playbackFrames()
            frameTicket = requestAnimationFrame(refreshPlayback)
          } else if (command === 'video-pause' || command === 'video-toggle') {
            cancelPlaybackFrames()
            const generation = playbackGeneration
            const image = await media.pauseFrame(
              () => playingMedia === media && playbackGeneration === generation && selected === p.id
            )
            pausedFrame = { media, image }
          } else if (command === 'video-seek') {
            stopPlayback()
            await media.seek(args.time, false, context.seekTrace)
          } else {
            const range = clipRange(args, media.duration)
            stopPlayback()
            await media.seek(range.start)
            await replace(p, { edit: { ...p.edit, trim: range } })
            rememberEdit(p)
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
          rememberEdit(p)
          redo.length = 0
          break
        }
        case 'preset-save':
          result = await presets.create(args.name, p.edit)
          break
        case 'preset-apply': {
          const preset = presets.get(args.id).edit
          const edit = { ...p.edit, ...preset }
          if (p.edit.processVersion !== undefined || preset.processVersion !== undefined)
            edit.processVersion = processingVersion(preset)
          await replace(p, { edit })
          rememberEdit(p)
          redo.length = 0
          compare = false
          break
        }
        case 'histogram':
          if (args.source === 'display') {
            const bins = displayedHistogram()
            if (!bins) throw Error(HISTOGRAM_MESSAGES.display)
            return structuredClone(bins)
          }
          return histogram(await render(await source(p.id), p.edit, 400))
        case 'auto-tone': {
          const exposure = autoExposure(
            histogram(await render(await source(p.id), neutralRecipe(p.edit), 400))
          )
          await replace(p, { edit: { ...p.edit, Exposure: exposure } })
          rememberEdit(p)
          redo.length = 0
          break
        }
        case 'sample-color': {
          const canvas = await render(await source(p.id), p.edit, 1280)
          return { color: sampleColor(canvas, number(args.x, 0, 1), number(args.y, 0, 1)) }
        }
        case 'range-color': {
          if (args.photoId !== undefined && args.photoId !== p.id) throw Error('The selected photo changed')
          const selection =
            args.id === undefined ? localToolsUI.selection() : { id: args.id, path: args.path ?? [] }
          const item = localToolAt(p.edit, selection.id, selection.path)
          if ((selection.id && !item) || (!selection.id && selection.path.length))
            throw Error('Mask component not found')
          const color = sampleSourceColor(await source(p.id), number(args.x, 0, 1), number(args.y, 0, 1))
          if (item?.type === 'color-range' && item.color !== color) {
            await execute(selection.path.length ? 'mask.component-update' : 'mask.update', {
              id: selection.id,
              path: selection.path,
              changes: { color },
              photoId: p.id
            })
          }
          localToolsUI.setRangeColor(color)
          return { color }
        }
        case 'grading-mode': {
          const cancelsDraft = args.mode !== gradingMode && adjustmentDraft?.state.command === 'grading-set'
          gradingMode = args.mode
          if (cancelsDraft) await draw()
          else updateColorGrading(p, { mode: gradingMode })
          return { mode: gradingMode }
        }
        case 'grading-set': {
          if (args.photoId !== undefined && args.photoId !== p.id) throw Error(GRADING_MESSAGES.changedPhoto)
          if (
            args.expectedValue !== undefined &&
            JSON.stringify(colorGradingValue({ colorGrading: args.expectedValue })) !==
              JSON.stringify(colorGradingValue(p.edit))
          )
            throw Error(GRADING_MESSAGES.changedEdit)
          const edit = args.patch
            ? patchColorGrading(p.edit, args.patch)
            : setColorGrading(p.edit, args.value)
          if (args.draft) return stageAdjustment(command, p, args, edit, context)
          if (JSON.stringify(edit.colorGrading) !== JSON.stringify(p.edit.colorGrading)) {
            await replace(p, { edit })
            rememberEdit(p)
            redo.length = 0
          }
          compare = false
          result = { value: colorGradingValue(edit) }
          break
        }
        case 'curve-channel': {
          const cancelsDraft = args.channel !== curveChannel && adjustmentDraft?.state.command === 'curve-set'
          curveChannel = args.channel
          curveIndex = 0
          curvePhoto = p.id
          if (cancelsDraft) await draw()
          else updateToneCurves(p, { channel: curveChannel, index: curveIndex })
          return { channel: curveChannel, index: curveIndex }
        }
        case 'curve-select':
          if (args.photoId !== undefined && args.photoId !== p.id) throw Error(CURVE_MESSAGES.changedPhoto)
          if (args.index >= curvePoints(p.edit, curveChannel).length)
            throw Error(CURVE_MESSAGES.invalidPoints)
          curveIndex = args.index
          curvePhoto = p.id
          updateToneCurves(p, { channel: curveChannel, index: curveIndex })
          return { channel: curveChannel, index: curveIndex }
        case 'curve-set': {
          if (args.photoId !== undefined && args.photoId !== p.id) throw Error(CURVE_MESSAGES.changedPhoto)
          const previous = curvePoints(p.edit, args.channel)
          if (
            args.expectedPoints !== undefined &&
            (args.expectedPoints.length !== previous.length ||
              args.expectedPoints.some((point, i) => point.x !== previous[i].x || point.y !== previous[i].y))
          )
            throw Error(CURVE_MESSAGES.changedEdit)
          const edit = setToneCurve(p.edit, args.channel, args.points)
          if (args.index !== undefined && args.index >= curvePoints(edit, args.channel).length)
            throw Error(CURVE_MESSAGES.invalidPoints)
          if (args.draft) return stageAdjustment(command, p, args, edit, context)
          if (JSON.stringify(edit.toneCurves) !== JSON.stringify(p.edit.toneCurves)) {
            await replace(p, { edit })
            rememberEdit(p)
            redo.length = 0
          }
          curveChannel = args.channel
          curveIndex = args.index ?? Math.min(curveIndex, curvePoints(edit, args.channel).length - 1)
          curvePhoto = p.id
          compare = false
          result = { channel: curveChannel, index: curveIndex, points: curvePoints(edit, curveChannel) }
          break
        }
        case 'point-select':
          if (args.photoId !== undefined && args.photoId !== p.id)
            throw Error(POINT_COLOR_MESSAGES.changedPhoto)
          if (!p.edit.pointColors?.some((point) => point.id === args.id))
            throw Error('Color sample not found')
          selectedPoint = args.id
          pointPhoto = p.id
          updatePoints(p.edit.pointColors, selectedPoint, pointPhoto)
          return { id: selectedPoint }
        case 'point-sample': {
          if (args.photoId !== undefined && args.photoId !== p.id)
            throw Error(POINT_COLOR_MESSAGES.changedPhoto)
          if (mode !== 'detail' || sampling !== 'point') throw Error(POINT_COLOR_MESSAGES.activateSampler)
          if (clipping) throw Error(POINT_COLOR_MESSAGES.clipping)
          const { canvas } = displayedSamplePreview(p, context.sampleCanvas, POINT_COLOR_MESSAGES)
          return execute('point-add', { color: sampleColor(canvas, args.x, args.y) })
        }
        case 'point-add':
        case 'point-update':
        case 'point-remove': {
          const { id, photoId, ...changes } = args
          if (photoId !== undefined && photoId !== p.id) throw Error(POINT_COLOR_MESSAGES.changedPhoto)
          const points = [...(p.edit.pointColors || [])]
          if (command === 'point-add') {
            const point = validatePoint({
              id: crypto.randomUUID(),
              color: changes.color,
              hue: 0,
              saturation: 0,
              luminance: 0,
              range: 15
            })
            points.push(point)
            result = point
          } else {
            const index = points.findIndex((v) => v.id === id)
            if (index < 0) throw Error('Color sample not found')
            if (command === 'point-remove') points.splice(index, 1)
            else points[index] = validatePoint({ ...points[index], ...changes })
          }
          await replace(p, { edit: { ...p.edit, pointColors: points } })
          if (command === 'point-add') {
            selectedPoint = result.id
            pointPhoto = p.id
            sampling = false
          }
          rememberEdit(p)
          redo.length = 0
          break
        }
        case 'white-balance':
        case 'white-balance-sample': {
          if (args.photoId !== undefined && args.photoId !== p.id)
            throw Error(WHITE_BALANCE_MESSAGES.changedPhoto)
          let point = args,
            image
          if (command === 'white-balance-sample') {
            if (mode !== 'detail' || sampling !== 'white') throw Error(WHITE_BALANCE_MESSAGES.activateSampler)
            const preview = displayedSamplePreview(p, context.sampleCanvas, WHITE_BALANCE_MESSAGES)
            image = preview.image
            point = viewToOriginal(args, image, preview.edit)
            if (!point) throw Error(WHITE_BALANCE_MESSAGES.outsideSource)
          } else image = await source(p.id)
          const values = neutralBalance(image, point.x, point.y)
          await replace(p, { edit: { ...p.edit, ...values } })
          rememberEdit(p)
          redo.length = 0
          sampling = false
          break
        }
        case 'compare':
          compare = !compare
          pair = sampling = cropping = false
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
        case 'export-previous': {
          const previous = loadExportSettings()[isVideo(p) ? 'video' : 'photo']
          if (!previous)
            throw Object.assign(Error(EXPORT_SETTINGS_MESSAGES.missing), { code: 'EXPORT_SETTINGS_MISSING' })
          return execute('export', previous)
        }
        case 'export':
        case 'preview':
          return preparePhotoExport(p, args, {
            original,
            source: (id) => source(id, p.edit),
            preview: command === 'preview',
            comparison: compare
          })
        default:
          throw Error('Unknown command: ' + command)
      }
    }
  }
  if (nextId && visible().some((row) => row.id === nextId))
    selected = organization.chooseMany(visible(), [nextId])
  await draw(pausedFrame, context.seekTrace)
  return result ?? snapshot()
}
globalThis.openlrStartupMilestone?.('catalog-read-started')
const ready = Promise.all([db.all('photos'), db.all('albums'), presets.load()]).then(async (values) => {
  globalThis.openlrStartupMilestone?.('catalog-read-finished')
  ;[photos, albums] = values
  await draw()
  globalThis.openlrStartupMilestone?.('workspace-ready')
})
export function run(command, args = {}, observe, context) {
  if (command === 'preview' && args?.source !== undefined)
    return queue
      .then(() => ready)
      .then(async () => {
        validateArgs(command, args)
        const result = await (args.source === 'local-draft'
          ? localToolsUI.draftImage(args.draftId)
          : draftImage(args.draftId))
        return observe ? observe(result, snapshot()) : result
      })
  if (command === 'export-status' || command === 'export-cancel') {
    return Promise.resolve().then(() => {
      validateArgs(command, args)
      const result = command === 'export-status' ? exportProgress.snapshot() : exportProgress.cancel(args.id)
      return observe ? observe(result, snapshot()) : result
    })
  }
  const next = queue
    .then(() => ready)
    .then(async () => {
      validateArgs(command, args)
      const previous = libraryHistory.checkpoint(command, photos, albums, local.state())
      const previousSelection = selected
      const result = await execute(command, args, context)
      libraryHistory.record(previous, photos, albums)
      const unchangedPoll =
        ((context?.draftSource || context?.localGesture) && result === null) ||
        (command === 'draft-cancel' && !result.canceled) ||
        (command === 'repair-source' && args.point === undefined && args.picking === undefined) ||
        (command === 'external-check' && !result.imported?.length) ||
        (command === 'export-settings' && args.options === undefined) ||
        (command === 'select-relative' && selected === previousSelection)
      if (
        !unchangedPoll &&
        !(result?.blob instanceof Blob) &&
        ![
          'state',
          'photos',
          'viewport',
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
function act(cmd, args, context) {
  return run(cmd, args, undefined, context).catch((e) => notice(e.message))
}
function actSelection(command, args = {}) {
  return act(command, { ...args, expectedIds: organization.targets(photos).map((p) => p.id) })
}
function gestureAdjustment(command, source, change) {
  if (!change) return act('draft-cancel', { id: '' }, { draftSource: source })
  return act(
    command,
    { ...structuredClone(change), photoId: source.photoId, draft: true },
    {
      draftSource: source,
      draftEdit: active()?.edit
    }
  )
}
const processingLabel = document.createElement('label')
processingLabel.textContent = PROCESS_MESSAGES.label
const processingSelect = document.createElement('select')
processingSelect.id = 'processing-version'
processingSelect.setAttribute('aria-label', PROCESS_MESSAGES.label)
processingSelect.append(option('1', PROCESS_MESSAGES.legacy), option('2', PROCESS_MESSAGES.linear))
processingSelect.onchange = async () => {
  await act('processing', { version: Number(processingSelect.value), photoId: selected })
  processingSelect.value = String(processingVersion(active()?.edit))
}
processingLabel.append(processingSelect)
$('reset').before(processingLabel)
const localToolContainer = document.createElement('div')
$('reset').before(localToolContainer)
localToolsUI = createLocalToolsUI({
  container: localToolContainer,
  run,
  getActive: active,
  notify: notice,
  onDraftChange: notifyWorkspaceChange
})
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
    let gesture
    input.onpointerdown = () => {
      gesture = null
    }
    input.onkeydown = (event) => {
      if (event.key !== 'Escape' && gesture?.canceled) gesture = null
    }
    input.oninput = () => {
      output.value = input.value
      if (gesture?.photoId !== selected)
        gesture = {
          photoId: selected,
          cancel() {
            this.canceled = true
          }
        }
      if (gesture.canceled) return
      gestureAdjustment('edit', gesture, { key, value: Number(input.value) })
    }
    input.onchange = () => {
      const source = gesture
      gesture = null
      if (source?.canceled) {
        input.value = active()?.edit[key] ?? 0
        output.value = input.value
        return
      }
      act('edit', { key, value: Number(input.value), photoId: selected }, { draftSource: source }).finally(
        () => {
          if (source) gestureAdjustment('edit', source)
        }
      )
    }
    input.onpointercancel = () => {
      if (gesture) gestureAdjustment('edit', gesture)
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
  const input = e.target,
    file = input.files[0],
    photo = active()
  try {
    if (!file) return
    if (!photo) throw Error('Select a photo first')
    const xml = await file.text()
    await run('apply-xmp', { xml, photoId: photo.id }, undefined, { expectedEdit: photo.edit })
  } catch (error) {
    notice(error.message)
  } finally {
    input.value = ''
  }
}
$('crop-tool').onclick = () => act('crop-tool')
$('clear-crop').onclick = () => act('edit', { key: 'crop', value: null, photoId: selected })
function notifyWorkspaceChange() {
  window.dispatchEvent(new Event('openlr-change'))
}
for (const [target, element] of Object.entries(scrollports))
  element.addEventListener(
    'scroll',
    () => {
      if (viewportElement(target, active())) notifyWorkspaceChange()
    },
    { passive: true }
  )
const cropSurface = new CropSurface($('stage'), () => act('crop-tool'), notifyWorkspaceChange)
function updateCropGuideControls() {
  $('crop-guide').value = cropSurface.guide.type
  $('crop-guide-orientation').value = cropSurface.guide.orientation
  $('crop-guide-orientation').disabled = !['triangle', 'golden-spiral'].includes(cropSurface.guide.type)
  $('crop-guide-orientation').closest('label').hidden = $('crop-guide-orientation').disabled
}
const guideLabel = document.createElement('label'),
  guideSelect = document.createElement('select')
guideSelect.id = 'crop-guide'
guideLabel.append(CROP_GUIDE_MESSAGES.label, guideSelect)
for (const [value, label] of Object.entries(CROP_GUIDES)) guideSelect.append(option(value, label))
const orientationLabel = document.createElement('label'),
  orientationSelect = document.createElement('select')
orientationSelect.id = 'crop-guide-orientation'
orientationLabel.append(CROP_GUIDE_MESSAGES.orientation, orientationSelect)
CROP_GUIDE_MESSAGES.orientations.forEach((label, value) => orientationSelect.append(option(value, label)))
$('crop-tool').closest('details').append(guideLabel, orientationLabel)
guideSelect.onchange = () => act('crop-guide', { type: guideSelect.value })
orientationSelect.onchange = () =>
  act('crop-guide', {
    type: guideSelect.value,
    orientation: Number(orientationSelect.value)
  })
updateCropGuideControls()
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
    const point = { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }
    act(
      sampling === 'point' ? 'point-sample' : 'white-balance-sample',
      { ...point, photoId: selected },
      { sampleCanvas: e.target }
    )
  } else if (!cropping && !pair) act('zoom')
}
$('remove-mask').onclick = () => {
  const id = document.querySelector('[aria-label="Local edit selection"]')?.value
  act('remove-mask', id ? { id } : {})
}
$('sample').onclick = () => act('sample-tool')
$('pair').onclick = () => act('compare-pair')
$('rate').onchange = (e) => actSelection('rate', { value: Number(e.target.value) })
$('flag').onchange = (e) => actSelection('flag', { value: e.target.value })
$('keywords').onchange = (e) => actSelection('keywords', { value: e.target.value })
$('color-label').onchange = (e) => actSelection('label', { value: e.target.value })
$('rename-photo').onchange = (e) => act('rename', { name: e.target.value, photoId: selected })
$('capture-time').onchange = (e) => actSelection('capture-time', { time: e.target.value })
let purgeSelection = null
$('purge').onclick = () => {
  purgeSelection = organization.targets(photos).map((photo) => photo.id)
  $('purge-dialog').returnValue = ''
  $('purge-dialog').showModal()
}
$('purge-dialog').onclose = (e) => {
  const expectedIds = purgeSelection
  purgeSelection = null
  if (e.target.returnValue === 'ok' && expectedIds) act('purge', { expectedIds })
  e.target.returnValue = ''
}
$('delete').onclick = () => actSelection(active()?.deleted ? 'restore' : 'delete')
$('membership').onchange = (e) => actSelection('membership', { album: e.target.value })
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
  if (!$('histogram-panel').open) return
  const bins = displayedHistogram()
  if (bins) drawHistogram($('histogram'), bins)
}
$('reset').onclick = () => act('reset')
for (const direction of ['left', 'right'])
  $(direction).onclick = () => act('rotate', { direction, photoId: selected })
$('flip').onclick = () => act('flip', { photoId: selected })
$('aspect').onchange = (e) => act('edit', { key: 'aspect', value: e.target.value, photoId: selected })
$('new-album').onclick = () => {
  $('album-name').value = ''
  $('album-dialog').showModal()
}
$('album-dialog').onclose = (e) => {
  if (e.target.returnValue === 'ok')
    act('album', { name: $('album-name').value, smart: $('smart-album').checked })
  e.target.returnValue = ''
}
const previousExportButton = document.createElement('button')
previousExportButton.id = 'export-previous'
previousExportButton.textContent = EXPORT_SETTINGS_MESSAGES.previous
previousExportButton.title = EXPORT_SETTINGS_MESSAGES.previousDescription
previousExportButton.setAttribute('aria-label', EXPORT_SETTINGS_MESSAGES.previousDescription)
previousExportButton.disabled = true
$('export').after(previousExportButton)
const exportProgressPanel = document.createElement('section'),
  exportProgressLabel = document.createElement('span'),
  exportProgressBar = document.createElement('progress'),
  exportCancelButton = document.createElement('button')
exportProgressPanel.id = 'export-progress'
exportProgressPanel.hidden = true
exportProgressLabel.setAttribute('role', 'status')
exportCancelButton.id = 'export-cancel'
exportCancelButton.textContent = EXPORT_PROGRESS_MESSAGES.cancel
exportProgressBar.setAttribute('aria-label', BATCH_EXPORT_MESSAGES.action(1))
exportProgressPanel.append(exportProgressLabel, exportProgressBar, exportCancelButton)
document.body.append(exportProgressPanel)
exportCancelButton.onclick = () => act('export-cancel', { id: exportCancelButton.dataset.job })
function updateExportProgress(job) {
  const running = job.status === 'running' || job.status === 'cancelling'
  exportProgressPanel.hidden = !running
  $('export').disabled = previousExportButton.disabled = running || !active()
  if (!running) return
  const text = EXPORT_PROGRESS_MESSAGES.progress(job.completed, job.total)
  if (exportProgressLabel.textContent !== text) exportProgressLabel.textContent = text
  exportProgressBar.max = Math.max(1, job.total)
  exportProgressBar.value =
    job.completed +
    (job.phase === 'writing' && job.totalBytes ? Math.min(0.99, job.writtenBytes / job.totalBytes) : 0)
  exportCancelButton.dataset.job = job.id
  exportCancelButton.disabled = job.status === 'cancelling'
  exportCancelButton.textContent =
    job.status === 'cancelling' ? EXPORT_PROGRESS_MESSAGES.cancelling : EXPORT_PROGRESS_MESSAGES.cancel
}
$('export').onclick = () => {
  try {
    const media = isVideo(active()) ? 'video' : 'photo',
      previous = loadExportSettings()[media],
      options = previous ?? normalizeExportSettings({}, media)
    for (const item of $('format').options)
      item.hidden = item.disabled = item.value.startsWith('video/') && media !== 'video'
    $('format').value = options.format
    $('format').dispatchEvent(new Event('change'))
    $('quality').value = Math.round((options.quality ?? 0.92) * 100)
    $('export-size').value = options.maxSize ?? ''
    $('watermark').value = options.watermark ?? ''
    if (options.colorSpace) exportColorSelect.value = options.colorSpace
    exportMetadataSelect.value = options.metadata ?? 'none'
    exportSharpeningSelect.value = options.outputSharpening ?? 'none'
    $('export-dialog').querySelector('h2').textContent = BATCH_EXPORT_MESSAGES.title(
      organization.selection.size
    )
    $('export-dialog').showModal()
  } catch (error) {
    notice(error.message)
  }
}
function reserveExportFolder() {
  const pending = beginExportFolder()
  // The serialized dispatcher may still be finishing another command.
  pending.catch(() => {})
  return pending
}
async function savePreparedExport(command, options, exportSink) {
  if (organization.selection.size > 1) {
    const result = await run(
      'export-selection',
      command === 'export-previous' ? { previous: true } : options,
      undefined,
      { exportSink }
    )
    notice(
      result.cancelled
        ? EXPORT_PROGRESS_MESSAGES.cancelled(result.files.length, result.total)
        : BATCH_EXPORT_MESSAGES.complete(result.files.length)
    )
    return
  }
  const result = await run(command, options)
  if (await saveExport(result.blob, result.filename)) {
    try {
      await run('export-settings', result.exportSettings)
    } catch (error) {
      throw Error(EXPORT_SETTINGS_MESSAGES.rememberFailed + error.message)
    }
  }
}
previousExportButton.onclick = async () => {
  try {
    await savePreparedExport(
      'export-previous',
      undefined,
      organization.selection.size > 1 ? reserveExportFolder() : undefined
    )
  } catch (error) {
    if (error.code === 'EXPORT_SETTINGS_MISSING') $('export').click()
    else notice(error.message)
  }
}
$('play-video').onclick = () => act('video-toggle', { photoId: $('video-bar').dataset.photoId })
$('video-position').onchange = (e) =>
  act('video-seek', { time: Number(e.target.value), photoId: $('video-bar').dataset.photoId })
$('trim-apply').onclick = () =>
  act('video-trim', {
    start: Number($('trim-start').value),
    end: Number($('trim-end').value),
    photoId: $('video-bar').dataset.photoId
  })
$('format').replaceChildren(...EXPORT_FORMATS.map((format) => option(format.value, format.label)))
const exportColorLabel = document.createElement('label'),
  exportColorSelect = document.createElement('select')
exportColorSelect.id = 'export-color-space'
exportColorLabel.append(EXPORT_COLOR_MESSAGES.label, exportColorSelect)
$('format').closest('label').after(exportColorLabel)
const exportMetadataLabel = document.createElement('label'),
  exportMetadataSelect = document.createElement('select')
exportMetadataSelect.id = 'export-metadata'
exportMetadataLabel.append(EXPORT_METADATA_MESSAGES.label, exportMetadataSelect)
exportColorLabel.after(exportMetadataLabel)
const exportSharpeningLabel = document.createElement('label'),
  exportSharpeningSelect = document.createElement('select')
exportSharpeningSelect.id = 'export-sharpening'
exportSharpeningLabel.append(OUTPUT_SHARPENING_MESSAGES.label, exportSharpeningSelect)
exportMetadataLabel.after(exportSharpeningLabel)
$('format').onchange = (e) => {
  const spaces = exportColorSpaces(e.target.value),
    previous = exportColorSelect.value
  exportColorSelect.replaceChildren(...spaces.map((id) => option(id, COLOR_SPACES[id].label)))
  exportColorSelect.value = spaces.includes(previous) ? previous : spaces[0] || ''
  exportColorSelect.disabled = spaces.length < 2
  exportColorLabel.hidden = !spaces.length
  const metadataPolicies = exportMetadataPolicies(e.target.value),
    previousMetadata = exportMetadataSelect.value
  exportMetadataSelect.replaceChildren(
    ...metadataPolicies.map((id) => option(id, EXPORT_METADATA_MESSAGES.policies[id]))
  )
  exportMetadataSelect.value = metadataPolicies.includes(previousMetadata) ? previousMetadata : 'none'
  exportMetadataSelect.disabled = !metadataPolicies.length
  exportMetadataLabel.hidden = !metadataPolicies.length
  const sharpeningLevels = outputSharpeningLevels(e.target.value),
    previousSharpening = exportSharpeningSelect.value
  exportSharpeningSelect.replaceChildren(
    ...sharpeningLevels.map((id) => option(id, OUTPUT_SHARPENING_MESSAGES.levels[id]))
  )
  exportSharpeningSelect.value = sharpeningLevels.includes(previousSharpening) ? previousSharpening : 'none'
  exportSharpeningSelect.disabled = !sharpeningLevels.length
  exportSharpeningLabel.hidden = !sharpeningLevels.length
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
$('export-dialog')
  .querySelector('form')
  .addEventListener('submit', (event) => {
    if (event.submitter?.value !== 'ok' || organization.selection.size < 2) return
    event.preventDefault()
    // Request directory permission during the actual user gesture, before queueing work.
    const exportSink = reserveExportFolder()
    $('export-dialog').close('')
    savePreparedExport('export', readExportOptions(), exportSink).catch((error) => notice(error.message))
  })
$('export-dialog').onclose = async (e) => {
  const accepted = e.target.returnValue === 'ok'
  e.target.returnValue = ''
  if (!accepted) return
  try {
    await savePreparedExport('export', readExportOptions())
  } catch (err) {
    notice(err.message)
  }
}
document.onkeydown = (e) => {
  if (e.key === 'Escape' && localToolsUI?.repairSource().picking && !document.querySelector('dialog[open]')) {
    e.preventDefault()
    act('repair-source', { picking: false })
    return
  }
  if (e.key === 'Escape' && opticsUI?.active() && !document.querySelector('dialog[open]')) {
    e.preventDefault()
    act('straighten-tool', { axis: 'off' })
    return
  }
  if (e.key === 'Escape' && localToolsUI?.hasDraft() && !document.querySelector('dialog[open]')) {
    e.preventDefault()
    act('local-cancel')
    return
  }
  if (e.key === 'Escape' && adjustmentDraft && !document.querySelector('dialog[open]')) {
    e.preventDefault()
    act('draft-cancel', { id: adjustmentDraft.state.id })
    return
  }
  if (document.querySelector('dialog[open]') || e.target.matches('input,select,textarea')) return
  const key = e.key.toLowerCase(),
    mod = e.ctrlKey || e.metaKey
  if ((key === 'enter' || key === ' ') && panelSummaries.has(e.target)) return
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
  else if (mod && key === 'z') act(e.shiftKey ? 'history-redo' : 'history-undo')
  else if (mod && key === 'f') $('search').focus()
  else if (mod && e.shiftKey && key === 'i') choosePhotos()
  else if (mod && key === 'e') previousExportButton.click()
  else if (!mod && key === 'e' && e.shiftKey) $('export').click()
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
  else if (!mod && key === 'escape') act('view', { mode: 'grid' })
  else if (!mod && /^Digit[0-5]$/.test(e.code))
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
  else if (!mod && ['arrowleft', 'arrowright'].includes(key))
    act('select-relative', { direction: key === 'arrowright' ? 'next' : 'previous' })
  else return
  e.preventDefault()
}
updatePoints = pointPanel(act)
updateToneCurves = mountToneCurves(act, (source, points, index) =>
  gestureAdjustment(
    'curve-set',
    source,
    points && {
      channel: source.channel,
      points,
      index,
      expectedPoints: source.points
    }
  )
)
updateColorGrading = mountColorGrading(act, (source, value) =>
  gestureAdjustment('grading-set', source, value && { value, expectedValue: source.value })
)
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
ready.catch((e) => {
  globalThis.openlrStartupMilestone?.('workspace-ready-failed')
  notice(e.message)
})
updateOrganization = mountOrganization(act)
updateStacks = stackMenu(act)
$('layout').onclick = () => act('grid-layout')
$('end-slides').onclick = () => act('slideshow', { stop: true })
updateMerge = mountMerge(run, notice)
updateEnhance = mountEnhance(run, notice)
opticsUI = mountOptics({ run, getActive: active, notify: notice })
migrationUI = mountMigration({ run, notify: notice })

// Capture base titles once, before draw can add live text such as a filter count.
const panels = new Map([['photos', scrollports.photos]])
const panelSummaries = new Set()
for (const panel of document.querySelectorAll('main details')) {
  const summary = panel.querySelector(':scope > summary')
  if (!summary) continue
  const name = summary.textContent.trim()
  panels.set(name, panel)
  panelSummaries.add(summary)
  summary.addEventListener('click', (event) => {
    event.preventDefault()
    act('panel', { name }, { panelSummary: true })
  })
}
