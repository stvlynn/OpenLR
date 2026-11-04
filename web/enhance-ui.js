export function mountEnhance(run, notify) {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props),
    open = el('button', { id: 'enhance-photo', textContent: 'Enhance / Denoise' }),
    dialog = el('dialog'),
    form = el('form'),
    mode = el('select'),
    strength = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: 1 }),
    submit = el('button', { type: 'submit', textContent: 'Create enhanced copy' }),
    cancel = el('button', { type: 'button', textContent: 'Cancel' }),
    status = el('output')
  mode.setAttribute('aria-label', 'Enhance mode')
  strength.setAttribute('aria-label', 'Enhance strength')
  mode.add(new Option('AI raster denoise · OIDN', 'denoise'))
  mode.add(new Option('AI super resolution · 3×', 'super-resolution'))
  status.setAttribute('role', 'status')
  const label = el('label', { textContent: 'Strength ' })
  label.append(strength)
  form.append(
    el('h2', { textContent: 'Enhance photo' }),
    el('p', {
      textContent:
        'Creates a new 8-bit PNG from the current edited photo. Original files and edits remain available.'
    }),
    mode,
    label,
    el('p', {
      textContent:
        'Denoise is trained on rendered-image noise and can soften detail. It is not sensor RAW denoising. Super resolution infers luminance detail; inspect the result.'
    }),
    status,
    submit,
    cancel
  )
  dialog.append(form)
  document.body.append(dialog)
  document.getElementById('organize-toolbar').append(open)
  let photoId,
    targetId,
    busy = false
  open.onclick = () => {
    targetId = photoId
    status.textContent = ''
    dialog.showModal()
  }
  cancel.onclick = () => dialog.close()
  dialog.oncancel = (event) => {
    if (busy) event.preventDefault()
  }
  form.onsubmit = async (event) => {
    event.preventDefault()
    if (busy) return
    busy = true
    submit.disabled = cancel.disabled = true
    status.textContent = 'Downloading the small model if needed and processing locally…'
    try {
      await run('enhance', { mode: mode.value, strength: Number(strength.value), photoId: targetId })
      dialog.close()
    } catch (error) {
      status.textContent = error.message
      notify(error.message)
    } finally {
      busy = false
      submit.disabled = cancel.disabled = false
    }
  }
  return (state) => {
    const photo = state.photos.find((photo) => photo.id === state.selected)
    photoId = photo?.id
    open.disabled = !photo || photo.mediaType?.startsWith('video/')
  }
}
