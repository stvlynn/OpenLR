import { OPTICS_CONTROLS, listLensProfiles } from './optics.js'
import { viewToOriginal } from './local-tools-ui.js'

export function mountOptics({ run, getActive, notify, onChange }) {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props)
  document.head.append(el('link', { rel: 'stylesheet', href: new URL('./optics.css', import.meta.url).href }))
  const panel = el('details', { id: 'optics-panel' }),
    summary = el('summary', { textContent: 'Optics & geometry' })
  const search = el('input', { type: 'search', placeholder: 'Search bundled Lensfun profiles' })
  search.setAttribute('aria-label', 'Search lens profiles')
  const select = el('select')
  select.setAttribute('aria-label', 'Lens profile')
  const match = el('button', { textContent: 'Match EXIF' }),
    apply = el('button', { textContent: 'Apply profile' })
  const focal = el('input', { type: 'number', min: '0.01', step: 'any' }),
    crop = el('input', { type: 'number', min: '0.01', step: 'any' })
  focal.setAttribute('aria-label', 'Lens focal length')
  crop.setAttribute('aria-label', 'Camera crop factor')
  const status = el('p', { className: 'tool-hint' })
  status.setAttribute('role', 'status')
  const enabled = el('input', { type: 'checkbox' }),
    distortion = el('input', { type: 'checkbox' }),
    tca = el('input', { type: 'checkbox' })
  enabled.setAttribute('aria-label', 'Enable optics and geometry')
  distortion.setAttribute('aria-label', 'Apply profile distortion')
  tca.setAttribute('aria-label', 'Apply profile TCA')
  const field = (label, input) => {
    const row = el('label', { textContent: label + ' ' })
    row.append(input)
    panel.append(row)
    return row
  }
  panel.append(summary)
  field('Enabled', enabled)
  panel.append(search)
  field('Profile', select)
  panel.append(match, apply)
  field('Focal length (mm)', focal)
  field('Camera crop factor', crop)
  field('Profile distortion', distortion)
  field('Profile TCA', tca)
  panel.append(status)
  const sliders = {}
  for (const [key, definition] of Object.entries(OPTICS_CONTROLS)) {
    const [min, max, step] = definition.range,
      input = el('input', { type: 'range', min, max, step }),
      output = el('output')
    input.setAttribute('aria-label', definition.label)
    const label = field(definition.label, output)
    label.append(input)
    sliders[key] = { input, output }
    input.oninput = () => {
      output.value = input.value
    }
    input.onchange = () => change({ [key]: Number(input.value) })
  }
  const axis = el('select')
  axis.setAttribute('aria-label', 'Straighten reference axis')
  axis.add(new Option('Horizontal reference', 'horizontal'))
  axis.add(new Option('Vertical reference', 'vertical'))
  const guide = el('button', { textContent: 'Draw straighten line' }),
    reset = el('button', { textContent: 'Reset optics & geometry' })
  panel.append(axis, guide, reset)
  document.getElementById('aspect').closest('details').before(panel)
  let asset = '',
    lastProfile = '',
    candidates = listLensProfiles(),
    mode = '',
    first = null,
    suppressClick = false,
    cleanup = () => {}
  function options(items = candidates) {
    select.replaceChildren(
      new Option('Choose a calibrated lens', ''),
      ...items.map((profile) => new Option(profile.model + ' · crop ' + profile.cropFactor, profile.id))
    )
  }
  function showError(error) {
    status.textContent = error.message
    notify(error.message)
    sync()
  }
  const change = (changes) => run('optics', { changes, photoId: getActive()?.id }).catch(showError)
  enabled.onchange = () => change({ enabled: enabled.checked })
  distortion.onchange = () => change({ profileDistortion: distortion.checked })
  tca.onchange = () => change({ profileTCA: tca.checked })
  search.oninput = () => {
    candidates = listLensProfiles(search.value)
    options()
  }
  select.onchange = () => {
    const profile = listLensProfiles().find((item) => item.id === select.value)
    if (profile) crop.value = String(profile.cropFactor)
  }
  match.onclick = async () => {
    try {
      const result = await run('lens-match')
      candidates = result.profiles
      options()
      if (result.profiles.length === 1) select.value = result.profiles[0].id
      if (result.cameras.length === 1) crop.value = result.cameras[0].cropFactor
      focal.value = getActive()?.metadata?.FocalLength ?? ''
      status.textContent =
        result.profiles.length +
        ' exact profile candidate(s). Review focal length and crop factor, then Apply. Manual search remains available.'
    } catch (error) {
      showError(error)
    }
  }
  apply.onclick = async () => {
    try {
      await run('lens-apply', {
        id: select.value,
        focal: Number(focal.value),
        cropFactor: Number(crop.value),
        photoId: getActive()?.id
      })
    } catch (error) {
      showError(error)
    }
  }
  reset.onclick = () => run('optics-reset', { photoId: getActive()?.id }).catch(showError)
  guide.onclick = () =>
    run('straighten-tool', { axis: mode ? 'off' : axis.value, photoId: getActive()?.id }).catch(showError)
  function setMode(value) {
    mode = value
    first = null
    guide.textContent = value ? 'Cancel straighten line' : 'Draw straighten line'
    status.textContent = value ? 'Click two points along a ' + value + ' reference line.' : ''
  }
  function sync() {
    const photo = getActive(),
      recipe = photo?.edit.optics ?? {},
      profile = recipe.profile
    if (asset !== photo?.id) {
      asset = photo?.id
      lastProfile = ''
      setMode('')
      focal.value = photo?.metadata?.FocalLength ?? ''
      crop.value = ''
      candidates = listLensProfiles()
      options()
    }
    if (profile?.id !== lastProfile) {
      lastProfile = profile?.id ?? ''
      if (profile) {
        if (![...select.options].some((option) => option.value === profile.id))
          select.add(new Option(profile.model, profile.id))
        select.value = profile.id
        focal.value = profile.focal
        crop.value = profile.cropFactor
      }
    }
    enabled.checked = recipe.enabled !== false
    distortion.checked = recipe.profileDistortion !== false
    tca.checked = recipe.profileTCA !== false
    distortion.disabled = !profile?.distortion
    tca.disabled = !profile?.tca
    for (const [key, { input, output }] of Object.entries(sliders)) {
      input.value = recipe[key] ?? OPTICS_CONTROLS[key].initial
      output.value = input.value
    }
    if (!mode)
      status.textContent = profile
        ? profile.model +
          ' · ' +
          profile.focal +
          ' mm · Lensfun CC BY-SA 3.0. ' +
          (!profile.tca
            ? 'No TCA calibration at this focal length.'
            : 'Distortion / TCA samples are calibrated.')
        : ''
    for (const node of [apply, match, guide, reset]) node.disabled = !photo
  }
  function mount(canvas, { image, edit, available = true }) {
    cleanup()
    if (!available) return
    const down = (event) => {
      if (!mode || event.button !== 0) return
      event.preventDefault()
      event.stopImmediatePropagation()
      suppressClick = true
      const bounds = canvas.getBoundingClientRect(),
        point = viewToOriginal(
          {
            x: (event.clientX - bounds.left) / bounds.width,
            y: (event.clientY - bounds.top) / bounds.height
          },
          image,
          edit
        )
      if (!point) {
        status.textContent = 'Choose a point on the source image, away from transparent edges.'
        return
      }
      if (!first) {
        first = point
        status.textContent = 'First point set. Click the other end of the reference line.'
        onChange?.()
        return
      }
      const start = first,
        axis = mode
      setMode('')
      run('straighten', { start, end: point, axis, photoId: getActive()?.id }).catch(showError)
    }
    const click = (event) => {
      if (consumeClick()) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    canvas.addEventListener('pointerdown', down, true)
    canvas.addEventListener('click', click, true)
    cleanup = () => {
      canvas.removeEventListener('pointerdown', down, true)
      canvas.removeEventListener('click', click, true)
    }
  }
  options()
  sync()
  function consumeClick() {
    const consume = Boolean(mode) || suppressClick
    suppressClick = false
    return consume
  }
  return {
    sync,
    mount,
    setMode,
    consumeClick,
    unmount: () => {
      cleanup()
      cleanup = () => {}
    },
    active: () => Boolean(mode),
    snapshot: () => ({ axis: mode || 'off', first: first ? { ...first } : null }),
    deactivate: () => setMode(''),
    panel
  }
}
