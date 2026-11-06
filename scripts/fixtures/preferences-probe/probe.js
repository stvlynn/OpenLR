// Frozen e162e9d localStorage behavior, retained as the comparison baseline.
const defaults = { autoAdvance: false, filenames: true, extensions: true, shortcuts: true }
const preferences = { ...defaults }
try {
  const saved = JSON.parse(localStorage.getItem('openlr.preferences'))
  for (const name of Object.keys(defaults))
    if (typeof saved?.[name] === 'boolean') preferences[name] = saved[name]
} catch {}
function setPreferences(values) {
  for (const [name, value] of Object.entries(values))
    if (!Object.hasOwn(defaults, name) || typeof value !== 'boolean')
      throw Error('Invalid preference ' + name)
  Object.assign(preferences, values)
  localStorage.setItem('openlr.preferences', JSON.stringify(preferences))
  return { ...preferences }
}

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('openlr-preference-probe', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('settings')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

async function persisted(db, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', value === undefined ? 'readonly' : 'readwrite', {
      durability: 'strict'
    })
    const store = tx.objectStore('settings')
    const request = value === undefined ? store.get('preferences') : store.put(value, 'preferences')
    tx.onabort = () => reject(tx.error ?? Error('Preference transaction aborted'))
    tx.oncomplete = () => resolve({ value: value ?? request.result, durability: tx.durability })
  })
}

const fixture = await globalThis.mygo.call('PreferencesProbe.Fixture')
const started = performance.now()
let db
let report = { ...fixture }
try {
  let before, after, durability, stored
  if (fixture.candidate === 'local-storage') {
    before = { ...preferences }
    after = fixture.phase === 'write' ? setPreferences({ filenames: fixture.value }) : before
    stored = JSON.parse(localStorage.getItem('openlr.preferences'))
  } else {
    db = await database()
    stored = (await persisted(db)).value
    before = stored ?? { autoAdvance: false, filenames: true, extensions: true, shortcuts: true }
    if (fixture.phase === 'write') {
      const result = await persisted(db, { ...before, filenames: fixture.value })
      after = result.value
      stored = result.value
      durability = result.durability
    } else after = before
  }
  report = {
    ...report,
    before,
    after,
    stored: stored ?? null,
    durability,
    elapsedMs: performance.now() - started
  }
} catch (error) {
  report.error = { name: error.name, message: error.message }
} finally {
  db?.close()
}
await globalThis.mygo.call('PreferencesProbe.Finish', JSON.stringify(report))
