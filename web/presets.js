import { validateColorGrading } from './color-grading.js'
import { all, save, transaction } from './catalog.js'
import { controls } from './adjustments.js'
import { processingVersion } from './process-version.js'
import { validateToneCurves } from './tone-curves.js'
const adjustments = Object.assign({}, ...Object.values(controls))
const builtIn = [
  { id: 'mono', name: 'Monochrome', edit: { Saturation: -100, Contrast: 9 } },
  { id: 'warm', name: 'Warm light', edit: { Temperature: 14, Highlights: -12, Shadows: 8 } },
  { id: 'soft', name: 'Soft contrast', edit: { Contrast: -16, Blacks: 9, Saturation: -6 } }
]
export class Presets {
  items = [...builtIn]
  async load() {
    this.items = [...builtIn, ...(await all('presets'))]
  }
  async create(name, recipe) {
    if (!name?.trim()) throw Error('Enter a preset name')
    processingVersion(recipe)
    const edit = Object.fromEntries(Object.entries(recipe).filter(([key]) => Object.hasOwn(adjustments, key)))
    if (Object.hasOwn(recipe, 'processVersion')) edit.processVersion = recipe.processVersion
    if (Object.hasOwn(recipe, 'toneCurves')) edit.toneCurves = validateToneCurves(recipe.toneCurves)
    if (Object.hasOwn(recipe, 'colorGrading')) edit.colorGrading = validateColorGrading(recipe.colorGrading)
    const preset = { id: crypto.randomUUID(), name: name.trim(), edit }
    await save('presets', preset)
    this.items.push(preset)
    return preset
  }
  get(id) {
    const preset = this.items.find((p) => p.id === id)
    if (!preset) throw Error('Preset not found')
    processingVersion(preset.edit)
    if (preset.edit.toneCurves !== undefined) validateToneCurves(preset.edit.toneCurves)
    if (preset.edit.colorGrading !== undefined) validateColorGrading(preset.edit.colorGrading)
    return preset
  }
  async remove(id) {
    this.get(id)
    if (builtIn.some((p) => p.id === id)) throw Error('Built-in preset')
    await transaction('presets', 'readwrite', (tx) => tx.objectStore('presets').delete(id))
    this.items = this.items.filter((p) => p.id !== id)
  }
  render(select) {
    const prev = select.value
    select.replaceChildren(...this.items.map((p) => new Option(p.name, p.id)))
    if (this.items.some((p) => p.id === prev)) select.value = prev
  }
  builtIn(id) {
    return builtIn.some((p) => p.id === id)
  }
}
