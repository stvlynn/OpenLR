import { validateColorGradingRecipe } from './color-grading.js'
import { decodeEditSource } from './edit-source.js'
import { renderPrepared as render, toBlob } from './render.js'
import { whenVisible } from './thumbnail-visibility.js'
import { processingVersion } from './process-version.js'
import { validateToneCurveRecipe } from './tone-curves.js'

const messages = {
  desktop: 'Local folders require the desktop app.',
  empty: 'No readable photos in this folder.',
  read: 'Cannot read the local photo.'
}
const placeholder = new Blob(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180" viewBox="0 0 240 180"><rect width="240" height="180" fill="#222"/><path d="M80 120l25-30 20 20 15-15 25 25" stroke="#777" fill="none" stroke-width="4"/><circle cx="145" cy="65" r="9" fill="#777"/></svg>'
  ],
  { type: 'image/svg+xml' }
)
let folder = null,
  roots = [],
  section,
  dispatch,
  report,
  thumbnailQueue = Promise.resolve(),
  generation = 0
const observers = new Set(),
  thumbnailControllers = new Set()
const call = (name, ...args) => {
  if (!globalThis.mygo?.call) throw Error(messages.desktop)
  return globalThis.mygo.call('Local.' + name, ...args)
}
function validateVersions(recipe) {
  processingVersion(recipe.edit || {})
  validateToneCurveRecipe(recipe.edit || {})
  validateColorGradingRecipe(recipe.edit || {})
  for (const version of recipe.versions || []) {
    processingVersion(version.edit || {})
    validateToneCurveRecipe(version.edit || {})
    validateColorGradingRecipe(version.edit || {})
  }
}
export const state = () =>
  folder
    ? {
        root: folder.root,
        relative: folder.relative,
        directories: folder.directories,
        recursive: folder.recursive
      }
    : null
export const isLocal = (photo) => Boolean(photo?.local)
export function leave() {
  folder = null
  generation++
  for (const controller of thumbnailControllers) controller.abort()
  thumbnailControllers.clear()
  for (const observer of observers) observer.disconnect()
  observers.clear()
  drawNavigation()
}

export async function open(root = '', relative = '', recursive = folder?.recursive ?? false) {
  let next = root
    ? await call(recursive ? 'OpenTree' : 'OpenFolder', root, relative)
    : await call('ChooseFolder')
  if (!root && next && recursive) next = await call('OpenTree', next.root.id, next.relative)
  if (next) next.recursive = recursive
  if (!next) return null
  generation++
  for (const controller of thumbnailControllers) controller.abort()
  thumbnailControllers.clear()
  for (const observer of observers) observer.disconnect()
  observers.clear()
  folder = next
  roots = await call('Folders')
  const warnings = []
  const photos = next.photos.map((entry) => {
    const recipe = entry.recipe || {}
    let sidecarError = entry.error || ''
    try {
      validateVersions(recipe)
    } catch (error) {
      sidecarError ||= error.message
    }
    if (sidecarError) warnings.push({ name: entry.name, error: sidecarError })
    return {
      ...recipe,
      id: 'local:' + next.root.id + ':' + entry.relative,
      name: entry.name,
      width: 0,
      height: 0,
      added: entry.modified,
      rating: recipe.rating || 0,
      flag: recipe.flag || '',
      keywords: recipe.keywords || '',
      deleted: recipe.deleted || false,
      albums: recipe.albums || [],
      edit: recipe.edit || {},
      thumbnail: placeholder,
      local: {
        root: next.root.id,
        relative: entry.relative,
        size: entry.size,
        modified: entry.modified,
        sidecarPresent: entry.sidecarPresent,
        sidecarError
      }
    }
  })
  drawNavigation()
  return { photos, warnings, folder: state() }
}

export async function original(photo) {
  const { root, relative, modified } = photo.local
  const origin =
    globalThis.mygo.platform === 'win32' ? 'http://localphoto.localhost' : 'localphoto://localhost'
  const path = relative.split('/').map(encodeURIComponent).join('/')
  const response = await fetch(`${origin}/${root}/${path}?revision=${modified}`)
  if (!response.ok) throw Error(`${messages.read} (${response.status})`)
  return { file: new File([await response.blob()], photo.name, { lastModified: modified }) }
}

export async function save(photo) {
  if (photo.local.sidecarError)
    throw Error(photo.local.sidecarError + '; repair or remove that sidecar before saving.')
  const { thumbnail, local, id, name, width, height, added, ...recipe } = photo
  validateVersions(recipe)
  await call('SaveRecipe', local.root, local.relative, JSON.stringify(recipe))
  local.sidecarPresent = true
}

// Decode only thumbnails that enter the viewport. Originals remain on disk.
export function observeThumbnail(photo, img, onReady) {
  if (!photo.local || photo.thumbnail !== placeholder) return
  if (photo.local.sidecarError) {
    img.alt = 'Cannot preview ' + photo.name
    img.title = photo.local.sidecarError
    return
  }
  const revision = generation
  const load = () => {
    thumbnailQueue = thumbnailQueue
      .catch(() => {})
      .then(async () => {
        if (revision !== generation || !img.isConnected) return
        let image
        const edit = photo.edit,
          controller = new AbortController()
        thumbnailControllers.add(controller)
        try {
          image = await decodeEditSource((await original(photo)).file, edit)
          if (revision !== generation) return
          const thumbnail = await toBlob(await render(image, edit, 240, { signal: controller.signal }))
          if (revision !== generation || photo.edit !== edit || !img.isConnected) return
          photo.width = image.width
          photo.height = image.height
          photo.thumbnail = thumbnail
          onReady()
        } catch (error) {
          if (error.name === 'AbortError' || revision !== generation) return
          img.alt = 'Cannot preview ' + photo.name
          img.title = error.message
          report?.(photo.name + ': ' + error.message)
        } finally {
          thumbnailControllers.delete(controller)
          image?.close()
        }
      })
  }
  const observer = whenVisible(img, load, (finished) => observers.delete(finished))
  if (observer) observers.add(observer)
}

export function mount(run, onError) {
  dispatch = run
  report = onError
  section = document.createElement('section')
  section.className = 'local-folders'
  section.hidden = !globalThis.mygo?.call
  document.querySelector('nav').prepend(section)
  drawNavigation()
  if (globalThis.mygo?.call)
    call('Folders')
      .then((value) => {
        roots = value
        drawNavigation()
      })
      .catch((error) => report(error.message))
}

export function drawNavigation() {
  if (!section) return
  const heading = document.createElement('h2')
  heading.textContent = 'Local'
  const button = (text, command, args = {}) => {
    const btn = document.createElement('button')
    btn.textContent = text
    btn.onclick = () => dispatch(command, args)
    return btn
  }
  const library = button('Photo library', 'library')
  library.hidden = !folder
  const choose = button('Open folder…', 'local-open')
  choose.disabled = !globalThis.mygo?.call
  choose.title = choose.disabled ? messages.desktop : 'Read photos in place; originals are not copied'
  section.replaceChildren(heading, library, choose)
  for (const root of roots) {
    const item = button(root.name, 'local-open', { root: root.id })
    item.title = root.path
    item.setAttribute('aria-pressed', folder?.root.id === root.id)
    section.append(item)
  }
  if (folder) {
    const current = document.createElement('small')
    current.textContent = folder.relative === '.' ? folder.root.name : folder.relative
    section.append(current)
    const label = document.createElement('label'),
      toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = folder.recursive
    toggle.onchange = () => dispatch('local-subfolders', { enabled: toggle.checked })
    label.append(toggle, ' Include subfolders')
    section.append(label)
    if (folder.relative !== '.') {
      const parent = folder.relative.split('/').slice(0, -1).join('/') || '.'
      section.append(button('↑ Parent folder', 'local-browse', { relative: parent }))
    }
    for (const entry of folder.directories)
      section.append(button('▸ ' + entry.name, 'local-browse', { relative: entry.relative }))
  }
}
