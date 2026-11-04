import { saveExport } from './desktop.js'
export function mountMerge(run, report) {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props)
  document.head.append(el('link', { rel: 'stylesheet', href: new URL('./merge.css', import.meta.url).href }))
  let state,
    busy = false,
    inputs = []
  const open = el('button', { id: 'merge-photos', textContent: 'Merge photos' }),
    radiance = el('button', { id: 'export-radiance', textContent: 'Export HDR radiance' })
  document.getElementById('organize-toolbar').append(open, radiance)
  const dialog = el('dialog', { id: 'merge-dialog' }),
    form = el('form'),
    heading = el('h2', { textContent: 'Merge photos' })
  const description = el('p', {
    textContent:
      'Create a new library photo from selected originals. Source files and their edits are preserved.'
  })
  const kind = el('select', { id: 'merge-kind' })
  kind.setAttribute('aria-label', 'Merge type')
  kind.add(new Option('Panorama · perspective', 'panorama'))
  kind.add(new Option('HDR · exposure brackets', 'hdr'))
  const sources = el('div', { id: 'merge-sources' }),
    hdr = el('div', { id: 'merge-hdr-settings' })
  const explain = el('p', {
    textContent:
      'EV offsets are relative brightness in stops, in source order. Enter actual brackets when exposure EXIF is missing, for example −2, 0, +2.'
  })
  const align = el('input', { type: 'checkbox', checked: true }),
    alignLabel = el('label', { textContent: 'Auto align handheld brackets ' })
  alignLabel.append(align)
  const note = el('p', {
    textContent:
      'Use consistent exposure and overlapping, textured frames. Wide, moving, or parallax-heavy scenes may not align reliably.'
  })
  const status = el('output', { id: 'merge-status' })
  status.setAttribute('role', 'status')
  const actions = el('div'),
    cancel = el('button', { type: 'button', textContent: 'Cancel' }),
    submit = el('button', { type: 'submit', textContent: 'Merge' })
  actions.append(cancel, submit)
  hdr.append(explain, alignLabel)
  form.append(heading, description, kind, sources, hdr, note, status, actions)
  dialog.append(form)
  document.body.append(dialog)
  const syncKind = () => {
    hdr.hidden = kind.value !== 'hdr'
    note.hidden = kind.value === 'hdr'
    for (const input of inputs) input.closest('label').hidden = kind.value !== 'hdr'
  }
  kind.onchange = syncKind
  open.onclick = () => {
    inputs = []
    sources.replaceChildren()
    status.textContent = ''
    const selected = state.selection
      .map((id) => state.photos.find((photo) => photo.id === id))
      .filter(Boolean)
    const exposure = (photo) => {
      const m = photo.metadata || {}
      return [m.ExposureTime, m.FNumber, m.ISO].every((value) => typeof value === 'number' && value > 0)
        ? (m.ExposureTime * m.ISO) / (100 * m.FNumber * m.FNumber)
        : null
    }
    const base = exposure(selected[0])
    for (const photo of selected) {
      const row = el('div', { className: 'merge-source' }),
        name = el('span', { textContent: photo.name }),
        label = el('label', { textContent: 'EV ' })
      const input = el('input', { type: 'number', step: 'any' })
      input.dataset.photo = photo.id
      input.setAttribute('aria-label', 'Exposure offset for ' + photo.name)
      const value = exposure(photo)
      input.value = value && base ? String(Math.log2(value / base)) : ''
      label.append(input)
      row.append(name, label)
      sources.append(row)
      inputs.push(input)
    }
    syncKind()
    dialog.showModal()
  }
  cancel.onclick = () => dialog.close()
  dialog.oncancel = (event) => {
    if (busy) event.preventDefault()
  }
  form.onsubmit = async (event) => {
    event.preventDefault()
    if (busy) return
    const args = { ids: inputs.map((input) => input.dataset.photo) }
    if (kind.value === 'hdr') {
      if (inputs.some((input) => input.value.trim() === '')) {
        status.textContent = 'Enter an EV offset for every source, or import photos with exposure EXIF.'
        return
      }
      args.evs = inputs.map((input) => Number(input.value))
      args.align = align.checked
    }
    busy = true
    submit.disabled = cancel.disabled = true
    status.textContent = 'Aligning and merging originals…'
    try {
      await run('merge-' + kind.value, args)
      dialog.close()
    } catch (error) {
      status.textContent = error.message
    } finally {
      busy = false
      submit.disabled = cancel.disabled = false
    }
  }
  radiance.onclick = async () => {
    try {
      const result = await run('export-hdr')
      await saveExport(result.blob, result.filename)
    } catch (error) {
      report(error.message)
    }
  }
  return (next) => {
    state = next
    open.hidden = next.selection.length < 2
    radiance.hidden = next.photos.find((photo) => photo.id === next.selected)?.merge?.kind !== 'hdr'
  }
}
