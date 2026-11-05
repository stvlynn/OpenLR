import { makeColorProfile } from '../../web/color-spaces.js'

export function iccCurve(type, parameters = []) {
  const sampled = type === 'curv',
    bytes = new Uint8Array(12 + parameters.length * (sampled ? 2 : 4)),
    view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode(sampled ? 'curv' : 'para'))
  if (sampled) {
    view.setUint32(8, parameters.length)
    parameters.forEach((value, i) => view.setUint16(12 + i * 2, value))
  } else {
    view.setUint16(8, type)
    parameters.forEach((value, i) => view.setInt32(12 + i * 4, Math.round(value * 65536)))
  }
  return bytes
}

export function iccTags(profile) {
  const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength),
    tags = {}
  for (let i = 0; i < view.getUint32(128); i++) {
    const entry = 132 + i * 12,
      id = String.fromCharCode(...profile.subarray(entry, entry + 4)),
      at = view.getUint32(entry + 4)
    tags[id] = profile.slice(at, at + view.getUint32(entry + 8))
  }
  return tags
}

export function rebuildIcc(replacements = {}, { source = makeColorProfile(), major = 4 } = {}) {
  const tags = { ...iccTags(source), ...replacements }
  for (const [id, value] of Object.entries(tags)) if (value === null) delete tags[id]
  const entries = Object.entries(tags),
    tableEnd = 132 + entries.length * 12,
    bytes = new Uint8Array(tableEnd + entries.reduce((n, [, payload]) => n + ((payload.length + 3) & ~3), 0)),
    view = new DataView(bytes.buffer)
  bytes.set(source.subarray(0, 128))
  bytes[8] = major
  view.setUint32(0, bytes.length)
  view.setUint32(128, entries.length)
  let at = tableEnd
  entries.forEach(([id, payload], i) => {
    const entry = 132 + i * 12
    bytes.set(new TextEncoder().encode(id), entry)
    view.setUint32(entry + 4, at)
    view.setUint32(entry + 8, payload.length)
    bytes.set(payload, at)
    at += (payload.length + 3) & ~3
  })
  return bytes
}

export function withIccCurve(payload, options = {}) {
  return rebuildIcc(Object.fromEntries(['rTRC', 'gTRC', 'bTRC'].map((id) => [id, payload])), options)
}

export function makeGrayProfile(payload = iccCurve(0, [2.2]), options = {}) {
  const bytes = rebuildIcc(
    { rXYZ: null, gXYZ: null, bXYZ: null, rTRC: null, gTRC: null, bTRC: null, chad: null, kTRC: payload },
    options
  )
  bytes.set(new TextEncoder().encode('GRAY'), 16)
  return bytes
}
