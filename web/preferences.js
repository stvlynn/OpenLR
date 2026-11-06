import { readSetting, saveSetting } from './catalog.js'

const defaults = { autoAdvance: false, filenames: true, extensions: true, shortcuts: true }
const key = 'openlr.preferences'
export const preferences = { ...defaults }
export async function loadPreferences() {
  const record = await readSetting('preferences')
  const legacy = record ? null : localStorage.getItem(key)
  const saved = record ? record.values : JSON.parse(legacy)
  const next = { ...defaults }
  for (const name of Object.keys(defaults)) if (typeof saved?.[name] === 'boolean') next[name] = saved[name]
  if (!record && legacy !== null) await saveSetting('preferences', next)
  Object.assign(preferences, next)
}
export async function setPreferences(values) {
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(defaults, name) || typeof value !== 'boolean')
      throw Error('Invalid preference ' + name)
  }
  const next = { ...preferences, ...values }
  await saveSetting('preferences', next)
  Object.assign(preferences, next)
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
    input.onchange = async () => {
      await run('preferences', { [key]: input.checked })
      input.checked = preferences[key]
    }
  }
  document.getElementById('settings').onclick = async () => {
    const values = await run('preferences')
    if (!values) return
    for (const input of dialog.querySelectorAll('input')) input.checked = values[input.name]
    dialog.showModal()
  }
}
export const colorLabels = ['', 'red', 'yellow', 'green', 'blue', 'purple']
export const displayName = (p) =>
  (preferences.extensions ? p.name : p.name.replace(/\.[^.]+$/, '')) +
  (p.virtual ? ' · Copy' : '') +
  (p.stackId ? ' ▤' : '')
