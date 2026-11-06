import { GRADING_WHEELS, GRADING_MESSAGES as messages, colorGradingValue, hueColor } from './color-grading.js'

export function mountColorGrading(run, preview = () => {}) {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props)
  const panel = el('details', { id: 'color-grading' })
  panel.append(el('summary', { textContent: messages.title }))
  const mode = el('select', { id: 'grading-mode' })
  mode.setAttribute('aria-label', messages.mode)
  for (const key of ['three', ...GRADING_WHEELS]) mode.add(new Option(messages.modes[key], key))
  const wheels = el('div', { className: 'grading-wheels' })
  panel.append(mode, wheels)
  const cards = new Map(),
    controls = [],
    pendingNumbers = new Map()
  let current = null,
    gesture = null,
    draft = null
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n))
  const wrap = (n) => ((n % 360) + 360) % 360
  const wheelImage = el('canvas', { width: 200, height: 200 })
  const ctx = wheelImage.getContext('2d'),
    pixels = ctx.createImageData(200, 200)
  for (let y = 0; y < 200; y++)
    for (let x = 0; x < 200; x++) {
      const dx = (x + 0.5 - 100) / 88,
        dy = (100 - y - 0.5) / 88
      const radius = Math.hypot(dx, dy),
        i = (y * 200 + x) * 4
      if (radius > 1) continue
      const color = hueColor(wrap((Math.atan2(dy, dx) * 180) / Math.PI))
      for (let c = 0; c < 3; c++) pixels.data[i + c] = 255 * (0.5 * (1 - radius) + color[c] * radius)
      pixels.data[i + 3] = 255
    }
  ctx.putImageData(pixels, 0, 0)

  function draw(value = current?.value) {
    mode.disabled = !current
    mode.value = current?.mode ?? 'three'
    wheels.dataset.mode = mode.value
    for (const control of controls) control.disabled = !current
    for (const [key, card] of cards) {
      card.root.hidden = mode.value === 'three' ? key === 'global' : key !== mode.value
      card.canvas.setAttribute('aria-disabled', String(!current))
      card.canvas.tabIndex = current ? 0 : -1
      const context = card.canvas.getContext('2d')
      context.clearRect(0, 0, 200, 200)
      context.drawImage(wheelImage, 0, 0)
      if (!value) continue
      const wheel = value[key],
        angle = (wheel.hue * Math.PI) / 180,
        radius = wheel.saturation * 0.88
      context.beginPath()
      context.arc(100 + Math.cos(angle) * radius, 100 - Math.sin(angle) * radius, 5, 0, Math.PI * 2)
      context.strokeStyle = '#121418'
      context.lineWidth = 4
      context.stroke()
      context.strokeStyle = '#fff'
      context.lineWidth = 2
      context.stroke()
      card.canvas.setAttribute(
        'aria-label',
        `${messages.modes[key]}: ${messages.hue} ${wheel.hue}, ${messages.saturation} ${wheel.saturation}`
      )
    }
    for (const control of controls) {
      if (!control.dataset.key || control === draft?.control) continue
      const target = control.dataset.wheel ? value?.[control.dataset.wheel] : value
      const pending = pendingNumbers.get(control)
      const displayed =
        !gesture && pending && pending.photoId === current?.photoId
          ? pending.value
          : target?.[control.dataset.key]
      const text = displayed === undefined ? '' : String(displayed)
      if (control.value !== text) control.value = text
    }
  }
  function cancel(notify = true) {
    const previous = gesture
    gesture = null
    if (previous?.pointer !== undefined && previous.control.hasPointerCapture(previous.pointer))
      previous.control.releasePointerCapture(previous.pointer)
    if (previous && notify) preview(previous.source, null)
    draw()
  }
  function commit(args, settle, draftSource) {
    return Promise.resolve(run('grading-set', args, { draftSource })).finally(() => {
      settle?.()
      if (!gesture) draw()
    })
  }
  function submit(value, source = current) {
    if (source)
      return commit({ value, photoId: source.photoId, expectedValue: source.value }, undefined, source)
  }
  function begin(control, pointer) {
    if (!current) return false
    cancel()
    const source = { photoId: current.photoId, value: structuredClone(current.value) }
    source.cancel = () => {
      source.canceled = true
      if (gesture?.source === source) cancel(false)
    }
    gesture = {
      control,
      pointer,
      source,
      revision: current.edit,
      mode: current.mode,
      value: structuredClone(source.value)
    }
    return true
  }
  function finish() {
    if (!gesture) return
    const previous = gesture
    gesture = null
    if (previous.pointer !== undefined && previous.control.hasPointerCapture(previous.pointer))
      previous.control.releasePointerCapture(previous.pointer)
    if (!equal(previous.value, previous.source.value))
      submit(previous.value, previous.source).finally(() => preview(previous.source, null))
    else {
      preview(previous.source, null)
      draw()
    }
  }
  function field(parent, key, wheel, low, high, range = false) {
    const id = `grading-${wheel ? `${wheel}-` : ''}${key}`
    const row = el('label', { className: 'grading-field', textContent: messages[key] })
    const input = el('input', {
      id: range ? `${id}-number` : id,
      type: 'number',
      min: low,
      max: high,
      step: 1
    })
    input.dataset.key = key
    if (wheel) input.dataset.wheel = wheel
    input.setAttribute('aria-label', `${wheel ? `${messages.modes[wheel]} ` : ''}${messages[key]}`)
    controls.push(input)
    row.append(input)
    parent.append(row)
    input.oninput = () => {
      if (!current || !panel.open || draft?.control === input) return
      const target = wheel ? current.value[wheel] : current.value
      const pending = pendingNumbers.get(input)
      // The dispatcher runs an earlier local commit before this draft can commit.
      const expectedValue = pending?.photoId === current.photoId ? pending.value : target[key]
      draft = { control: input, photoId: current.photoId, expectedValue }
    }
    input.onchange = () => {
      if (draft?.control !== input) return
      const { photoId, expectedValue } = draft
      draft = null
      const number = Number(input.value)
      if (!panel.open || input.value === '' || !Number.isFinite(number) || number < low || number > high)
        return draw(gesture?.value ?? current?.value)
      const pending = { photoId, value: number }
      pendingNumbers.set(input, pending)
      cancel()
      commit(
        { photoId, patch: { field: wheel ? `${wheel}.${key}` : key, value: number, expectedValue } },
        () => {
          if (pendingNumbers.get(input) === pending) pendingNumbers.delete(input)
        }
      )
    }
    input.onblur = () => {
      if (draft?.control !== input) return
      draft = null
      draw(gesture?.value ?? current?.value)
    }
    if (!range) return
    const slider = el('input', { id, type: 'range', min: low, max: high, step: 1 })
    slider.dataset.key = key
    if (wheel) slider.dataset.wheel = wheel
    slider.setAttribute('aria-label', input.getAttribute('aria-label'))
    controls.push(slider)
    parent.append(slider)
    slider.oninput = () => {
      const number = Number(slider.value)
      if (!gesture || gesture.control !== slider) if (!begin(slider)) return
      ;(wheel ? gesture.value[wheel] : gesture.value)[key] = number
      draw(gesture.value)
      preview(gesture.source, gesture.value)
    }
    slider.onchange = finish
    slider.onpointercancel = cancel
    slider.onblur = () => {
      if (gesture?.control === slider) cancel()
    }
  }
  for (const key of GRADING_WHEELS) {
    const root = el('section', { className: 'grading-card', id: `grading-${key}` })
    const heading = el('div', { className: 'grading-heading' })
    const reset = el('button', { id: `grading-${key}-reset`, textContent: '↺', title: messages.resetWheel })
    reset.setAttribute('aria-label', `${messages.resetWheel} ${messages.modes[key]}`)
    heading.append(el('span', { textContent: messages.modes[key] }), reset)
    const canvas = el('canvas', { id: `grading-wheel-${key}`, width: 200, height: 200, tabIndex: 0 })
    canvas.setAttribute('role', 'group')
    canvas.setAttribute('aria-label', `${messages.modes[key]} ${messages.wheel}`)
    const coordinates = el('div', { className: 'grading-coordinates' })
    root.append(heading, canvas, coordinates)
    field(coordinates, 'hue', key, 0, 360)
    field(coordinates, 'saturation', key, 0, 100)
    field(root, 'luminance', key, -100, 100, true)
    cards.set(key, { root, canvas })
    wheels.append(root)
    controls.push(reset)
    reset.onclick = () => {
      if (!current) return
      cancel()
      const value = structuredClone(current.value)
      value[key] = colorGradingValue({})[key]
      submit(value)
    }
    function point(event) {
      const rect = canvas.getBoundingClientRect(),
        dx = (event.clientX - rect.left) / rect.width - 0.5,
        dy = 0.5 - (event.clientY - rect.top) / rect.height
      const wheel = gesture.value[key]
      wheel.saturation = clamp((Math.hypot(dx, dy) / 0.44) * 100, 0, 100)
      if (wheel.saturation > 0) wheel.hue = wrap((Math.atan2(dy, dx) * 180) / Math.PI)
      draw(gesture.value)
      preview(gesture.source, gesture.value)
    }
    canvas.onpointerdown = (event) => {
      if (event.button !== 0 || !current) return
      event.preventDefault()
      canvas.focus()
      if (!begin(canvas, event.pointerId)) return
      canvas.setPointerCapture(event.pointerId)
      point(event)
    }
    canvas.onpointermove = (event) => {
      if (gesture?.control === canvas && gesture.pointer === event.pointerId) point(event)
    }
    canvas.onpointerup = (event) => {
      if (gesture?.control === canvas && gesture.pointer === event.pointerId) finish()
    }
    canvas.onpointercancel = cancel
    canvas.onlostpointercapture = () => {
      if (gesture?.control === canvas) cancel()
    }
    canvas.onkeydown = (event) => {
      if (
        !current ||
        gesture ||
        !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)
      )
        return
      event.preventDefault()
      event.stopPropagation()
      const value = structuredClone(current.value),
        wheel = value[key],
        step = event.shiftKey ? 10 : 1
      if (event.key === 'Home') wheel.saturation = 0
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
        wheel.hue = wrap(wheel.hue + (event.key === 'ArrowRight' ? step : -step))
      else wheel.saturation = clamp(wheel.saturation + (event.key === 'ArrowUp' ? step : -step), 0, 100)
      submit(value)
    }
  }
  const shared = el('div', { className: 'grading-shared' })
  field(shared, 'blending', null, 0, 100, true)
  field(shared, 'balance', null, -100, 100, true)
  const reset = el('button', { id: 'grading-reset', textContent: messages.reset })
  controls.push(reset)
  panel.append(shared, reset)
  reset.onclick = () => {
    cancel()
    submit(colorGradingValue({}))
  }
  mode.onchange = () => {
    const value = mode.value
    draft = null
    cancel()
    run('grading-mode', { mode: value })
  }
  panel.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && (gesture || draft)) {
        event.preventDefault()
        event.stopPropagation()
        draft = null
        cancel()
      }
    },
    true
  )
  panel.addEventListener('toggle', () => {
    if (!panel.open) {
      draft = null
      cancel()
    }
  })
  const anchor = document.getElementById('tone-curves')
  if (anchor) anchor.after(panel)
  else document.getElementById('adjustments').append(panel)
  return (photo, selection = { mode: 'three' }) => {
    const next = photo
      ? { photoId: photo.id, edit: photo.edit, value: colorGradingValue(photo.edit), mode: selection.mode }
      : null
    if (!panel.open || next?.photoId !== current?.photoId || next?.mode !== current?.mode) draft = null
    if (
      gesture &&
      (!next ||
        next.photoId !== gesture.source.photoId ||
        next.edit !== gesture.revision ||
        next.mode !== gesture.mode ||
        !equal(next.value, gesture.source.value))
    )
      cancel()
    current = next
    draw(gesture?.value ?? current?.value)
  }
}
