import { controls } from './adjustments.js'
import { geometry, validCrop } from './geometry.js'
import { validateFill } from './fill.js'
import { validEye } from './culling.js'
import { validatePoint } from './point-color.js'
import { validateLocalTool } from './local-tools.js'
import { validateArgs } from './agent-protocol.js'
import { validateOptics } from './optics.js'

const ns = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  dc: 'http://purl.org/dc/elements/1.1/',
  crs: 'http://ns.adobe.com/camera-raw-settings/1.0/',
  olr: 'https://github.com/stvlynn/OpenLR/ns/1.0/'
}
export const CRS_FIELDS = {
  Exposure: 'Exposure2012',
  Contrast: 'Contrast2012',
  Highlights: 'Highlights2012',
  Shadows: 'Shadows2012',
  Whites: 'Whites2012',
  Blacks: 'Blacks2012',
  Saturation: 'Saturation',
  Vibrance: 'Vibrance',
  Texture: 'Texture',
  Clarity: 'Clarity2012',
  Sharpening: 'Sharpness',
  'Noise reduction': 'LuminanceSmoothing'
}
const fields = CRS_FIELDS
const ranges = Object.assign({}, ...Object.values(controls))
const escapeXml = (s) =>
  String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
export function exportXmp(p) {
  const edit = p.edit || {},
    attrs = { 'xmp:Rating': p.rating || 0, 'crs:HasSettings': 'True', 'olr:Flag': p.flag || '' }
  for (const [key, prop] of Object.entries(fields))
    if (edit[key] !== undefined) attrs['crs:' + prop] = edit[key]
  if ((edit.crop || edit.aspect) && p.width && p.height) {
    const { x, y, w, h } = geometry(p, edit)
    Object.assign(attrs, {
      'crs:HasCrop': 'True',
      'crs:CropLeft': x / p.width,
      'crs:CropTop': y / p.height,
      'crs:CropRight': (x + w) / p.width,
      'crs:CropBottom': (y + h) / p.height
    })
  }
  const attributes = Object.entries(attrs)
    .map(([k, v]) => k + '="' + escapeXml(v) + '"')
    .join(' ')
  const keywords = (p.keywords || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ' +
    Object.entries(ns)
      .map(([k, v]) => 'xmlns:' + k + '="' + v + '"')
      .join(' ') +
    '><rdf:Description rdf:about="" ' +
    attributes +
    '><dc:subject><rdf:Bag>' +
    keywords.map((k) => '<rdf:li>' + escapeXml(k) + '</rdf:li>').join('') +
    '</rdf:Bag></dc:subject><olr:Recipe>' +
    escapeXml(JSON.stringify(edit)) +
    '</olr:Recipe></rdf:Description></rdf:RDF></x:xmpmeta>'
  )
}
function safeRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw Error('Invalid XMP recipe')
  const result = {}
  for (const [key, value] of Object.entries(recipe)) {
    if (key === 'redEyes') {
      if (!Array.isArray(value) || !value.every(validEye)) throw Error('Invalid red-eye regions')
      result.redEyes = value
    } else if (key === 'pointColors') result.pointColors = value.map(validatePoint)
    else if (key === 'fills') result.fills = value.map(validateFill)
    else if (key === 'trim') {
      if (
        !Number.isFinite(value?.start) ||
        !Number.isFinite(value.end) ||
        value.start < 0 ||
        value.end <= value.start
      )
        throw Error('Invalid video trim points')
      result.trim = { start: value.start, end: value.end }
    } else if (key === 'optics') {
      result.optics = validateOptics(value)
    } else if (key === 'localTools') {
      const tools = {}
      for (const [group, kind] of [
        ['repairs', 'repair'],
        ['masks', 'mask']
      ])
        tools[group] = (value[group] ?? []).map((item) => validateLocalTool(kind, item))
      result.localTools = tools
    } else {
      validateArgs('edit', { key, value })
      result[key] = value
    }
  }
  return result
}
export function readXmp(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.doctype || doc.querySelector('parsererror')) throw Error('Invalid XMP document')
  const descriptions = Array.from(doc.getElementsByTagNameNS(ns.rdf, 'Description'))
  if (!descriptions.length) throw Error('XMP has no RDF description')
  const get = (prefix, key) => {
    for (const d of descriptions) {
      if (d.hasAttributeNS(ns[prefix], key)) return d.getAttributeNS(ns[prefix], key)
      const el = d.getElementsByTagNameNS(ns[prefix], key)[0]
      if (el) return el.textContent
    }
    return null
  }
  const changes = {},
    edit = {},
    custom = get('olr', 'Recipe')
  for (const [key, prop] of Object.entries(fields)) {
    const value = get('crs', prop)
    if (value === null || !Number.isFinite(Number(value))) continue
    edit[key] = Math.max(ranges[key][0], Math.min(ranges[key][1], Number(value)))
  }
  if (get('crs', 'HasCrop')?.toLowerCase() === 'true') {
    const [x, y, right, bottom] = ['CropLeft', 'CropTop', 'CropRight', 'CropBottom'].map((k) =>
      Number(get('crs', k))
    )
    const crop = { x, y, w: right - x, h: bottom - y }
    if (validCrop(crop)) edit.crop = crop
  }
  if (custom !== null) changes.edit = safeRecipe(JSON.parse(custom))
  else if (Object.keys(edit).length) changes.edit = edit
  const rating = get('xmp', 'Rating')
  if (rating !== null) {
    const n = Number(rating)
    if (Number.isInteger(n) && n >= 0 && n <= 5) changes.rating = n
    else if (n === -1) changes.flag = 'reject'
  }
  const flag = get('olr', 'Flag')
  if (['pick', 'reject', ''].includes(flag)) changes.flag = flag
  const subject = doc.getElementsByTagNameNS(ns.dc, 'subject')[0]
  if (subject)
    changes.keywords = Array.from(subject.getElementsByTagNameNS(ns.rdf, 'li'))
      .map((e) => e.textContent)
      .join(', ')
  return changes
}
export async function exportPackage(photo, file) {
  const { zipSync, strToU8 } = await import('./vendor/fflate/browser.js')
  const filename = photo.name.split(/[\\/]/).at(-1),
    stem = filename.replace(/\.[^.]+$/, '')
  const files = Object.create(null)
  files[filename] = new Uint8Array(await file.arrayBuffer())
  files[stem + '.xmp'] = strToU8(exportXmp(photo))
  return {
    blob: new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' }),
    filename: stem + '.zip'
  }
}
