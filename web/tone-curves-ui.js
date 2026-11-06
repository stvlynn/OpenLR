import { CURVE_CHANNELS, CURVE_MESSAGES, curvePoints, compileCurve } from './tone-curves.js'

export function mountToneCurves(run, preview = () => {}) {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props)
  const svg = (tag, attributes = {}) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
    return node
  }
  const panel = el('details', { id: 'tone-curves' })
  panel.append(el('summary', { textContent: CURVE_MESSAGES.title }))
  const channel = el('select', { id: 'curve-channel' })
  channel.setAttribute('aria-label', CURVE_MESSAGES.channel)
  for (const value of CURVE_CHANNELS) channel.add(new Option(CURVE_MESSAGES.channels[value], value))
  const graph = svg('svg', {
    id: 'curve-graph',
    viewBox: '0 0 240 240',
    tabindex: 0,
    role: 'group',
    'aria-label': CURVE_MESSAGES.graph
  })
  const grid = svg('g', { class: 'curve-grid' })
  for (let i = 0; i <= 4; i++) {
    const position = 12 + (216 * i) / 4
    grid.append(
      svg('line', { x1: position, x2: position, y1: 12, y2: 228 }),
      svg('line', { x1: 12, x2: 228, y1: position, y2: position })
    )
  }
  graph.append(grid, svg('line', { class: 'curve-diagonal', x1: 12, y1: 228, x2: 228, y2: 12 }))
  const path = svg('path', { class: 'curve-line' }),
    knots = svg('g', { class: 'curve-knots' })
  graph.append(path, knots)
  const point = el('select', { id: 'curve-point' })
  point.setAttribute('aria-label', CURVE_MESSAGES.point)
  const input = el('input', { id: 'curve-input', type: 'number', min: 0, max: 1, step: 0.01 }),
    output = el('input', { id: 'curve-output', type: 'number', min: 0, max: 1, step: 0.01 })
  const coordinates = el('div', { className: 'curve-coordinates' })
  for (const [label, field] of [
    [CURVE_MESSAGES.input, input],
    [CURVE_MESSAGES.output, output]
  ]) {
    const row = el('label', { textContent: label })
    field.setAttribute('aria-label', label)
    row.append(field)
    coordinates.append(row)
  }
  const actions = el('div', { className: 'curve-actions' }),
    add = el('button', { id: 'curve-add', textContent: CURVE_MESSAGES.add }),
    remove = el('button', { id: 'curve-delete', textContent: CURVE_MESSAGES.remove }),
    reset = el('button', { id: 'curve-reset', textContent: CURVE_MESSAGES.reset })
  actions.append(add, remove, reset)
  panel.append(channel, graph, point, coordinates, actions)
  const curvePanel = [...document.querySelectorAll('#adjustments details')].find(
    (item) => item.querySelector('summary')?.textContent === 'Curve'
  )
  if (curvePanel) curvePanel.after(panel)
  else document.getElementById('adjustments').append(panel)

  let current = null,
    gesture = null
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const clamp = (value) => Math.max(0, Math.min(1, value))
  function draw(points = current?.points, index = current?.index) {
    const enabled = Boolean(current)
    for (const control of [channel, point, input, output, add, remove, reset]) control.disabled = !enabled
    graph.setAttribute('aria-disabled', String(!enabled))
    if (!enabled) {
      path.removeAttribute('d')
      knots.replaceChildren()
      point.replaceChildren()
      input.value = output.value = ''
      return
    }
    const evaluate = compileCurve(points)
    channel.value = current.channel
    graph.dataset.channel = current.channel
    path.setAttribute(
      'd',
      Array.from(
        { length: 217 },
        (_, i) => `${i ? 'L' : 'M'}${12 + i} ${228 - 216 * evaluate(i / 216)}`
      ).join(' ')
    )
    knots.replaceChildren(
      ...points.map((p, i) =>
        svg('circle', {
          cx: 12 + p.x * 216,
          cy: 228 - p.y * 216,
          r: i === index ? 5 : 4,
          'data-index': i,
          class: i === index ? 'selected' : ''
        })
      )
    )
    point.replaceChildren(...points.map((p, i) => new Option(`${CURVE_MESSAGES.point} ${i + 1}`, i)))
    point.value = String(index)
    input.value = String(points[index].x)
    output.value = String(points[index].y)
    input.disabled = index === 0 || index === points.length - 1
    remove.disabled = input.disabled
  }
  function submit(points, index, source = current) {
    if (!source) return
    return Promise.resolve(
      run(
        'curve-set',
        { channel: source.channel, points, index, photoId: source.photoId, expectedPoints: source.points },
        { draftSource: source }
      )
    ).finally(() => {
      if (!gesture) draw()
    })
  }
  function move(points, index, x, y) {
    const next = structuredClone(points)
    if (index > 0 && index < points.length - 1 && x !== points[index].x) {
      const low = points[index - 1].x,
        high = points[index + 1].x,
        gap = Math.max(Number.EPSILON, (high - low) * 1e-6)
      const left = low + gap,
        right = high - gap
      if (left > low && right < high && left <= right) next[index].x = Math.max(left, Math.min(right, x))
    }
    next[index].y = clamp(y)
    return next
  }
  function cancelGesture(notify = true) {
    const previous = gesture,
      pointer = previous?.pointer
    gesture = null
    if (pointer !== undefined && graph.hasPointerCapture(pointer)) graph.releasePointerCapture(pointer)
    if (previous && notify) preview(previous.source, null)
    draw()
  }
  channel.onchange = () => {
    const value = channel.value
    cancelGesture()
    run('curve-channel', { channel: value })
    draw()
  }
  point.onchange = () => {
    if (!current) return
    const index = Number(point.value)
    cancelGesture()
    run('curve-select', { index, photoId: current.photoId })
    draw()
  }
  for (const field of [input, output])
    field.onchange = () => {
      if (!current) return
      const x = Number(input.value),
        y = Number(output.value)
      if (!input.value || !output.value || !Number.isFinite(x) || !Number.isFinite(y)) return draw()
      cancelGesture()
      submit(move(current.points, current.index, x, y), current.index)
    }
  add.onclick = () => {
    if (!current) return
    cancelGesture()
    const points = structuredClone(current.points)
    let index = 1
    for (let i = 2; i < points.length; i++)
      if (points[i].x - points[i - 1].x > points[index].x - points[index - 1].x) index = i
    const x = (points[index - 1].x + points[index].x) / 2
    if (x === points[index - 1].x || x === points[index].x) return
    points.splice(index, 0, { x, y: compileCurve(points)(x) })
    submit(points, index)
  }
  remove.onclick = () => {
    if (!current || current.index === 0 || current.index === current.points.length - 1) return
    cancelGesture()
    const points = structuredClone(current.points)
    points.splice(current.index, 1)
    submit(points, Math.min(current.index, points.length - 1))
  }
  reset.onclick = () => {
    cancelGesture()
    submit(
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 }
      ],
      0
    )
  }
  function position(event) {
    const rect = graph.getBoundingClientRect()
    return {
      x: clamp((((event.clientX - rect.left) * 240) / rect.width - 12) / 216),
      y: clamp((228 - ((event.clientY - rect.top) * 240) / rect.height) / 216)
    }
  }
  graph.onpointerdown = (event) => {
    if (!current || event.button !== 0) return
    event.preventDefault()
    graph.focus()
    const p = position(event),
      source = structuredClone(current),
      points = structuredClone(current.points)
    let index = points.findIndex((q) => Math.hypot((q.x - p.x) * 216, (q.y - p.y) * 216) <= 10)
    if (index < 0) {
      index = points.findIndex((q) => q.x >= p.x)
      if (index <= 0 || points[index].x === p.x) return
      points.splice(index, 0, p)
    } else run('curve-select', { index, photoId: source.photoId })
    source.cancel = () => {
      source.canceled = true
      if (gesture?.source === source) cancelGesture(false)
    }
    gesture = { pointer: event.pointerId, source, points, index }
    graph.setPointerCapture(event.pointerId)
    draw(points, index)
    preview(source, points, index)
  }
  graph.onpointermove = (event) => {
    if (!gesture || gesture.pointer !== event.pointerId) return
    const p = position(event)
    gesture.points = move(gesture.points, gesture.index, p.x, p.y)
    draw(gesture.points, gesture.index)
    preview(gesture.source, gesture.points, gesture.index)
  }
  graph.onpointerup = (event) => {
    if (!gesture || gesture.pointer !== event.pointerId) return
    const { source, points, index } = gesture
    gesture = null
    graph.releasePointerCapture(event.pointerId)
    if (equal(points, source.points)) {
      preview(source, null)
      return draw()
    }
    submit(points, index, source).finally(() => preview(source, null))
  }
  graph.onpointercancel = cancelGesture
  graph.onlostpointercapture = () => {
    if (gesture) cancelGesture()
  }
  graph.onkeydown = (event) => {
    if (!current) return
    if (event.key === 'Escape' && gesture) {
      event.preventDefault()
      event.stopPropagation()
      return cancelGesture()
    }
    if (gesture) return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      return remove.click()
    }
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }
    if (!directions[event.key]) return
    event.preventDefault()
    event.stopPropagation()
    const [dx, dy] = directions[event.key],
      step = event.shiftKey ? 0.1 : 0.01,
      p = current.points[current.index]
    submit(move(current.points, current.index, p.x + dx * step, p.y + dy * step), current.index)
  }
  return (photo, selection = { channel: 'rgb', index: 0 }) => {
    const next = photo
      ? {
          photoId: photo.id,
          channel: selection.channel,
          index: selection.index,
          points: curvePoints(photo.edit, selection.channel)
        }
      : null
    if (
      gesture &&
      (!next ||
        next.photoId !== gesture.source.photoId ||
        next.channel !== gesture.source.channel ||
        !equal(next.points, gesture.source.points))
    )
      cancelGesture()
    current = next
    if (current) current.index = Math.max(0, Math.min(current.points.length - 1, current.index))
    draw(gesture?.points ?? current?.points, gesture?.index ?? current?.index)
  }
}
