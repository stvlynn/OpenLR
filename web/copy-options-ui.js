import { COPY_GROUPS, COPY_MESSAGES } from './copy-options.js'

export function mountCopyOptions(run, getPhotoId) {
  const element = (tag, props = {}) => Object.assign(document.createElement(tag), props)
  const dialog = element('dialog', { id: 'copy-edits-dialog' })
  dialog.setAttribute('aria-labelledby', 'copy-edits-heading')
  const form = element('form', { method: 'dialog' })
  const heading = element('h2', { id: 'copy-edits-heading', textContent: COPY_MESSAGES.title })
  const shortcuts = element('div', { className: 'copy-shortcuts' })
  const groups = element('fieldset', { className: 'copy-groups' })
  groups.setAttribute('aria-label', COPY_MESSAGES.title)
  const inputs = COPY_GROUPS.map((group) => {
    const label = element('label')
    const input = element('input', {
      type: 'checkbox',
      name: 'copy-group',
      value: group.id,
      checked: true
    })
    label.append(input, document.createTextNode(group.label))
    groups.append(label)
    return input
  })
  const cancel = element('button', {
    id: 'copy-edits-cancel',
    value: 'cancel',
    textContent: COPY_MESSAGES.cancel
  })
  const accept = element('button', {
    id: 'copy-edits-confirm',
    value: 'ok',
    textContent: COPY_MESSAGES.copy
  })
  const refresh = () => {
    accept.disabled = !inputs.some((input) => input.checked)
  }
  groups.onchange = refresh
  for (const [id, checked] of [
    ['all', true],
    ['none', false]
  ]) {
    const button = element('button', {
      type: 'button',
      id: 'copy-edits-' + id,
      textContent: COPY_MESSAGES[id]
    })
    button.onclick = () => {
      inputs.forEach((input) => {
        input.checked = checked
      })
      refresh()
    }
    shortcuts.append(button)
  }
  const actions = element('div')
  actions.append(cancel, accept)
  form.append(heading, shortcuts, groups, actions)
  dialog.append(form)
  document.body.append(dialog)
  let source = null
  dialog.onclose = () => {
    const photoId = source
    source = null
    if (dialog.returnValue === 'ok' && photoId) {
      const keys = COPY_GROUPS.flatMap((group, index) => (inputs[index].checked ? group.keys : []))
      if (keys.length) run('copy-edits', { keys, photoId })
    }
    dialog.returnValue = ''
  }
  const button = element('button', { id: 'choose-edits', textContent: COPY_MESSAGES.choose })
  button.onclick = () => {
    source = getPhotoId()
    if (!source) return
    refresh()
    dialog.returnValue = ''
    dialog.showModal()
  }
  return button
}
