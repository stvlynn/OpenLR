import {
  SMART_ALBUM_MESSAGES,
  SMART_RATING_OPTIONS,
  SMART_FLAG_OPTIONS,
  SMART_EDIT_OPTIONS
} from './smart-album-rule.js'

export function mountOrganization(run) {
  const element = (tag, props = {}, ...children) => Object.assign(document.createElement(tag), props)
  const button = (text, fn) => {
    const b = element('button', { textContent: text })
    b.onclick = fn
    return b
  }
  let current
  const toolbar = element('div', { id: 'organize-toolbar', className: 'organize-toolbar' })
  const count = element('span', { id: 'selection-count' })
  const selectAll = button('Select all', () => run('select-all'))
  const clear = button('Clear selection', () => run('select-many', { ids: [] }))
  const copy = button('Copy edits', () => run('copy-edits'))
  copy.id = 'copy-edits'
  const paste = button('Paste edits', () => run('paste-edits'))
  paste.id = 'paste-edits'
  const selectedActions = element('div', { className: 'selection-actions' })
  selectedActions.append(clear, copy, paste)
  const select = (name, options, fn) => {
    const input = element('select')
    input.setAttribute('aria-label', name)
    for (const [value, label] of options) input.add(new Option(label, value))
    input.onchange = () => fn(input.value)
    return input
  }
  const rating = select('Minimum rating', SMART_RATING_OPTIONS, (value) =>
    run('filter', { rating: Number(value) })
  )
  const flag = select('Filter flags', SMART_FLAG_OPTIONS, (value) => run('filter', { flag: value }))
  const edited = select('Filter edits', SMART_EDIT_OPTIONS, (value) => run('filter', { edited: value }))
  const direction = select(
    'Sort direction',
    [
      ['desc', 'Descending'],
      ['asc', 'Ascending']
    ],
    (value) => run('sort', { order: current.order, direction: value })
  )
  const filters = element('details', { id: 'catalog-filters' }),
    filterSummary = element('summary', { textContent: 'Filters' })
  const filterOptions = element('div', { className: 'filter-options' })
  for (const [label, input] of [
    ['Rating', rating],
    ['Flag', flag],
    ['Edit status', edited]
  ]) {
    const field = element('label', { textContent: label })
    field.append(input)
    filterOptions.append(field)
  }
  filters.append(filterSummary, filterOptions)
  toolbar.append(count, selectAll, selectedActions, filters)
  document.getElementById('order').after(direction)
  document.getElementById('gallery').before(toolbar)

  const dialog = element('dialog', { id: 'organize-dialog' })
  const form = element('form', { method: 'dialog' })
  const heading = element('h2'),
    description = element('p'),
    name = element('input', { required: true })
  name.setAttribute('aria-label', 'Name')
  const cancel = element('button', { value: 'cancel', textContent: 'Cancel', formNoValidate: true }),
    accept = element('button', { value: 'ok', textContent: 'Save' })
  const actions = element('div')
  actions.append(cancel, accept)
  form.append(heading, description, name, actions)
  dialog.append(form)
  document.body.append(dialog)
  let pending = null
  function ask(title, initial, descriptionText, fn) {
    heading.textContent = title
    description.textContent = descriptionText
    description.hidden = !descriptionText
    name.hidden = initial === null
    name.required = initial !== null
    name.value = initial ?? ''
    accept.textContent = initial === null ? 'Delete' : 'Save'
    pending = fn
    dialog.returnValue = ''
    dialog.showModal()
  }
  dialog.onclose = () => {
    const fn = pending
    pending = null
    if (dialog.returnValue === 'ok') fn?.(name.value)
  }
  const albumTools = element('div', { className: 'album-tools' })
  const rename = button('Rename album', () => {
    const id = current.scope
    ask('Rename album', current.albums.find((a) => a.id === id)?.name, '', (name) =>
      run('album-rename', { id, name })
    )
  })
  rename.id = 'rename-album'
  const remove = button('Delete album', () => {
    const id = current.scope
    ask('Delete album', null, 'Photos stay in your library and other albums.', () =>
      run('album-delete', { id })
    )
  })
  remove.id = 'delete-album'
  const ruleDialog = element('dialog', { id: 'smart-album-dialog' }),
    ruleForm = element('form', { method: 'dialog' }),
    ruleHeading = element('h2', { textContent: SMART_ALBUM_MESSAGES.title }),
    ruleText = element('input', { type: 'search' }),
    ruleRating = select(SMART_ALBUM_MESSAGES.rating, SMART_RATING_OPTIONS, () => {}),
    ruleFlag = select(SMART_ALBUM_MESSAGES.flag, SMART_FLAG_OPTIONS, () => {}),
    ruleEdited = select(SMART_ALBUM_MESSAGES.edited, SMART_EDIT_OPTIONS, () => {})
  ruleText.setAttribute('aria-label', SMART_ALBUM_MESSAGES.search)
  ruleForm.append(ruleHeading)
  for (const [label, input] of [
    [SMART_ALBUM_MESSAGES.search, ruleText],
    [SMART_ALBUM_MESSAGES.rating, ruleRating],
    [SMART_ALBUM_MESSAGES.flag, ruleFlag],
    [SMART_ALBUM_MESSAGES.edited, ruleEdited]
  ]) {
    const field = element('label', { textContent: label })
    field.append(input)
    ruleForm.append(field)
  }
  const ruleActions = element('div')
  ruleActions.append(
    element('button', { value: 'cancel', textContent: SMART_ALBUM_MESSAGES.cancel, formNoValidate: true }),
    element('button', { value: 'ok', textContent: SMART_ALBUM_MESSAGES.save })
  )
  ruleForm.append(ruleActions)
  ruleDialog.append(ruleForm)
  document.body.append(ruleDialog)
  let ruleAlbumId = null
  const editRules = button(SMART_ALBUM_MESSAGES.edit, () => {
    const album = current.albums.find((album) => album.id === current.scope)
    if (!album?.rule || current.local) return
    ruleAlbumId = album.id
    ruleText.value = album.rule.text
    ruleRating.value = album.rule.rating
    ruleFlag.value = album.rule.flag
    ruleEdited.value = album.rule.edited
    ruleDialog.returnValue = ''
    ruleDialog.showModal()
  })
  editRules.id = 'edit-album-rules'
  ruleDialog.onclose = () => {
    const id = ruleAlbumId
    ruleAlbumId = null
    if (ruleDialog.returnValue === 'ok')
      run('album-rule', {
        id,
        rule: {
          text: ruleText.value,
          rating: Number(ruleRating.value),
          flag: ruleFlag.value,
          edited: ruleEdited.value
        }
      })
    ruleDialog.returnValue = ''
  }
  albumTools.append(editRules, rename, remove)
  document.getElementById('albums').after(albumTools)

  const versions = element('details', { id: 'versions' }),
    summary = element('summary', { textContent: 'Versions' })
  const save = button('Save version', () =>
    ask('Save version', '', '', (name) => run('version-save', { name }))
  )
  save.id = 'save-version'
  const list = element('div', { id: 'version-list' })
  versions.append(summary, save, list)
  document.querySelector('aside').append(versions)
  return (state) => {
    current = state
    const photo = state.photos.find((p) => p.id === state.selected),
      album = !state.local && state.albums.some((a) => a.id === state.scope)
    count.textContent = state.selection.length + ' selected'
    count.hidden = !state.selection.length
    selectedActions.hidden = !state.selection.length
    selectAll.disabled = !state.photos.length
    clear.disabled = !state.selection.length
    copy.disabled = !photo
    paste.disabled = !state.selection.length || !state.clipboard
    rename.disabled = remove.disabled = !album
    editRules.hidden = !album || !state.albums.find((item) => item.id === state.scope)?.rule
    albumTools.hidden = !album
    const activeFilters =
      Number(state.filters.rating > 0) +
      Number(state.filters.flag !== 'any') +
      Number(state.filters.edited !== 'any')
    filterSummary.textContent = 'Filters' + (activeFilters ? ' (' + activeFilters + ')' : '')
    rating.value = state.filters.rating
    flag.value = state.filters.flag
    edited.value = state.filters.edited
    direction.value = state.sortDirection
    save.disabled = !photo
    list.replaceChildren(
      ...(photo?.versions ?? []).map((version) => {
        const row = element('div', { className: 'version-row' })
        const label = element('span', { textContent: version.name })
        const restore = button('Restore', () => run('version-restore', { id: version.id }))
        restore.setAttribute('aria-label', 'Restore version ' + version.name)
        const rename = button('Rename', () =>
          ask('Rename version', version.name, '', (name) => run('version-rename', { id: version.id, name }))
        )
        rename.setAttribute('aria-label', 'Rename version ' + version.name)
        const remove = button('Delete', () =>
          ask('Delete version', null, 'Current edits and the original photo stay unchanged.', () =>
            run('version-delete', { id: version.id })
          )
        )
        remove.setAttribute('aria-label', 'Delete version ' + version.name)
        row.append(label, restore, rename, remove)
        return row
      })
    )
  }
}
