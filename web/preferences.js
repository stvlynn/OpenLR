const defaults = { autoAdvance: false, filenames: true, extensions: true, shortcuts: true }
const key = 'openlr.preferences'
export const preferences = { ...defaults }
try {
  const saved = JSON.parse(localStorage.getItem(key))
  for (const name of Object.keys(defaults))
    if (typeof saved?.[name] === 'boolean') preferences[name] = saved[name]
} catch {}
export function setPreferences(values) {
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(defaults, name) || typeof value !== 'boolean')
      throw Error('Invalid preference ' + name)
  }
  Object.assign(preferences, values)
  localStorage.setItem(key, JSON.stringify(preferences))
  return { ...preferences }
}
export function mountPreferences(run) {
  const dialog = document.getElementById('preferences')
  const labels = {
    autoAdvance: 'Advance after rating or flagging',
    filenames: 'Show file names in grid',
    extensions: 'Show file extensions',
    shortcuts: 'Single-key shortcuts'
  }
  for (const [key, label] of Object.entries(labels)) {
    const row = document.createElement('label'),
      input = document.createElement('input')
    input.type = 'checkbox'
    input.name = key
    row.append(input, ' ' + label)
    dialog.querySelector('section').append(row)
    input.onchange = () => run('preferences', { [key]: input.checked })
  }
  document.getElementById('settings').onclick = () => {
    for (const input of dialog.querySelectorAll('input')) input.checked = preferences[input.name]
    dialog.showModal()
  }
}
export const colorLabels = ['', 'red', 'yellow', 'green', 'blue', 'purple']
export const displayName = (p) =>
  (preferences.extensions ? p.name : p.name.replace(/\.[^.]+$/, '')) +
  (p.virtual ? ' · Copy' : '') +
  (p.stackId ? ' ▤' : '')
