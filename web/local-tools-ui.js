import { geometry } from './geometry.js'
import { LOCAL_CONTROLS, localToolAt } from './local-tools.js'
import { compileOptics, renderOpticsSource } from './optics.js'
import { AI_TARGETS } from './ai-models.js'
import { maskCoverageSource } from './mask-preview.js'
import { toBlob } from './render.js'

export const LOCAL_DRAFT_MESSAGES = Object.freeze({
  tool: 'Choose the corresponding local tool in Detail before previewing a stroke',
  changed: 'The local stroke draft changed'
})

const clamp = (v) => Math.max(0, Math.min(1, v))
export function viewToOriginal(point, image, edit = {}) {
  const g = geometry(image, edit),
    turn = ((g.turn % 4) + 4) % 4
  let { x, y } = point
  if (turn === 1) [x, y] = [y, 1 - x]
  if (turn === 2) [x, y] = [1 - x, 1 - y]
  if (turn === 3) [x, y] = [1 - y, x]
  if (g.flip) x = 1 - x
  const corrected = { x: (g.x + x * g.w) / image.width, y: (g.y + y * g.h) / image.height }
  const mapping = compileOptics(image, edit.optics),
    original = mapping.toOriginal(corrected)
  if (mapping.active && (original.x < 0 || original.y < 0 || original.x > 1 || original.y > 1)) return null
  return { x: clamp(original.x), y: clamp(original.y) }
}
export function originalToView(point, image, edit = {}) {
  const g = geometry(image, edit),
    turn = ((g.turn % 4) + 4) % 4
  const corrected = compileOptics(image, edit.optics).fromOriginal(point)
  if (!corrected) return { x: NaN, y: NaN }
  let x = (corrected.x * image.width - g.x) / g.w,
    y = (corrected.y * image.height - g.y) / g.h
  if (g.flip) x = 1 - x
  if (turn === 1) [x, y] = [1 - y, x]
  if (turn === 2) [x, y] = [1 - x, 1 - y]
  if (turn === 3) [x, y] = [y, 1 - x]
  return { x, y }
}
function element(tag, attributes = {}, text) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
  if (text) node.textContent = text
  return node
}
export function createLocalToolsUI({ container, run, getActive, notify, onDraftChange = () => {} }) {
  const panel = element('details', { class: 'local-tools' }),
    heading = element('summary', {}, 'Masks & local repair')
  const mode = element('select', { 'aria-label': 'Local tool' }),
    tools = [
      ['off', 'Navigate'],
      ['linear', 'Linear gradient'],
      ['radial', 'Radial gradient'],
      ['brush', 'Brush mask'],
      ['clone', 'Clone'],
      ['heal', 'Heal texture']
    ]
  tools.forEach(([value, label]) => mode.append(element('option', { value }, label)))
  const list = element('select', { 'aria-label': 'Local edit selection' }),
    status = element('p', { class: 'tool-hint' }, 'Choose a tool, then drag on the image.')
  const choose = element('button', { type: 'button' }, 'Choose repair source'),
    remove = element('button', { type: 'button' }, 'Remove local edit')
  const invert = element('input', { type: 'checkbox', 'aria-label': 'Invert mask' }),
    enabled = element('input', { type: 'checkbox', 'aria-label': 'Enable local edit' })
  const sliders = {}
  const field = (text, node) => {
    const label = element('label')
    label.append(text, node)
    panel.append(label)
    return label
  }
  panel.append(heading)
  field('Tool ', mode)
  field('Edit ', list)
  const aiTarget = element('select', { 'aria-label': 'AI mask target' }),
    generate = element('button', { type: 'button' }, 'Generate AI mask')
  for (const target of AI_TARGETS)
    aiTarget.append(element('option', { value: target }, target[0].toUpperCase() + target.slice(1)))
  field('AI selection ', aiTarget)
  panel.append(
    generate,
    element(
      'p',
      { class: 'tool-hint' },
      'Runs locally. Sky downloads a 172 MB model once and caches it; photos stay on this device.'
    )
  )
  generate.onclick = async () => {
    generate.disabled = true
    status.textContent =
      aiTarget.value === 'sky' ? 'Preparing sky model and selection…' : 'Generating selection…'
    try {
      const result = await run('ai-mask', {
        target: aiTarget.value,
        photoId: getActive()?.id,
        adjustments: {}
      })
      status.textContent = 'Generated ' + result.target + ' selection. Adjust, invert or disable it below.'
    } catch (error) {
      status.textContent = error.message
      notify(error.message)
    } finally {
      generate.disabled = false
    }
  }
  const rangeInputs = {
    color: element('input', { type: 'color', value: '#808080', 'aria-label': 'Range color' }),
    tolerance: element('input', {
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      value: 0.1,
      'aria-label': 'Range tolerance'
    }),
    min: element('input', {
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      value: 0.2,
      'aria-label': 'Range minimum'
    }),
    max: element('input', {
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      value: 0.8,
      'aria-label': 'Range maximum'
    }),
    softness: element('input', {
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      value: 0.1,
      'aria-label': 'Range softness'
    })
  }
  for (const [name, input] of Object.entries(rangeInputs)) {
    field('Range ' + name + ' ', input)
    input.onchange = () => {
      const item = selectedItem()
      if (
        item &&
        ['color-range', 'luminance-range', 'depth-range'].includes(item.type) &&
        Object.hasOwn(item, name)
      )
        commit('mask.update', {
          id: item.id,
          changes: { [name]: name === 'color' ? input.value : Number(input.value) }
        })
    }
  }
  const sampleColor = element('button', { type: 'button' }, 'Sample range color')
  panel.append(sampleColor)
  sampleColor.onclick = () =>
    run('local-tool', { tool: 'color-sample', photoId: getActive()?.id }).catch((error) =>
      notify(error.message)
    )
  for (const [type, label] of [
    ['color-range', 'Create color range'],
    ['luminance-range', 'Create luminance range']
  ]) {
    const button = element('button', { type: 'button' }, label)
    panel.append(button)
    button.onclick = () =>
      commit('mask.add', {
        mask: {
          type,
          ...Object.fromEntries(
            (type === 'color-range' ? ['color', 'tolerance', 'softness'] : ['min', 'max', 'softness']).map(
              (name) => [name, name === 'color' ? rangeInputs[name].value : Number(rangeInputs[name].value)]
            )
          ),
          adjustments: {}
        }
      })
  }
  const operand = element('select', { 'aria-label': 'Combine with mask' })
  field('Combine with ', operand)
  const component = element('select', { 'aria-label': 'Mask component' }),
    operation = element('select', { 'aria-label': 'Composite operation' })
  field('Component ', component)
  for (const value of ['add', 'subtract', 'intersect']) operation.append(element('option', { value }, value))
  field('Operation ', operation)
  operation.onchange = () => {
    const item = selectedItem()
    if (item?.type === 'composite')
      commit('mask.update', { id: item.id, changes: { operation: operation.value } })
  }
  for (const operation of ['add', 'subtract', 'intersect']) {
    const button = element(
      'button',
      { type: 'button' },
      operation[0].toUpperCase() + operation.slice(1) + ' mask'
    )
    panel.append(button)
    button.onclick = () => {
      const item = selectedItem()
      if (item) commit('mask.combine', { id: item.id, operandId: operand.value, operation })
    }
  }
  const depthMask = element('button', { type: 'button' }, 'Create depth range'),
    blur = element('button', { type: 'button' }, 'Apply lens blur'),
    blurEnabled = element('input', { type: 'checkbox', 'aria-label': 'Enable lens blur' }),
    focus = {}
  panel.append(
    element(
      'p',
      { class: 'tool-hint' },
      'Depth runs locally; downloads a 27 MB model once. Relative depth: 0 far, 1 near. It does not measure distance.'
    ),
    depthMask
  )
  for (const [name, value] of Object.entries({ amount: 0.025, min: 0.2, max: 0.5, softness: 0.15 })) {
    const input = element('input', {
      type: 'number',
      min: 0,
      max: name === 'amount' ? 0.15 : 1,
      step: 0.005,
      value,
      'aria-label': 'Lens blur ' + name
    })
    focus[name] = input
    field('Lens blur ' + name + ' ', input)
    input.onchange = () => {
      if (getActive()?.edit.localTools?.depth) commit('lens-blur', { [name]: Number(input.value) })
    }
  }
  field('Lens blur enabled ', blurEnabled)
  panel.append(blur)
  blurEnabled.onchange = () => commit('lens-blur', { enabled: blurEnabled.checked })
  const depthOperation = async (command, args, button) => {
    button.disabled = true
    status.textContent = 'Preparing depth model and inference…'
    try {
      await run(command, { ...args, photoId: getActive()?.id })
      if (command === 'depth-range') {
        list.value = getActive()?.edit.localTools?.masks.at(-1)?.id ?? ''
        mode.value = 'off'
      }
      sync()
      status.textContent = 'Depth operation complete.'
    } catch (error) {
      status.textContent = error.message
      notify(error.message)
    } finally {
      button.disabled = false
    }
  }
  blur.onclick = () =>
    depthOperation(
      'lens-blur',
      {
        enabled: true,
        ...Object.fromEntries(Object.entries(focus).map(([name, input]) => [name, Number(input.value)]))
      },
      blur
    )
  depthMask.onclick = () =>
    depthOperation(
      'depth-range',
      {
        min: Number(rangeInputs.min.value),
        max: Number(rangeInputs.max.value),
        softness: Number(rangeInputs.softness.value),
        adjustments: {}
      },
      depthMask
    )
  for (const [name, [min, max, step, initial]] of Object.entries({
    radius: [0.001, 0.5, 0.001, 0.05],
    feather: [0, 1, 0.01, 0.5],
    opacity: [0, 1, 0.01, 1],
    ...LOCAL_CONTROLS
  })) {
    const defaultValue = initial ?? 0
    const slider = element('input', {
        type: 'range',
        min,
        max,
        step,
        value: defaultValue,
        'aria-label': 'Local ' + name
      }),
      output = element('output', {}, String(defaultValue))
    const label = field(name[0].toUpperCase() + name.slice(1) + ' ', output)
    label.append(slider)
    sliders[name] = slider
    slider.oninput = () => {
      output.value = slider.value
    }
    slider.onchange = () => {
      const item = selectedItem()
      if (!item) return
      const isAdjustment = Object.hasOwn(LOCAL_CONTROLS, name),
        isRepair = ['clone', 'heal'].includes(item.type)
      if (
        (isAdjustment && isRepair) ||
        (name === 'radius' && !['brush', 'clone', 'heal'].includes(item.type))
      )
        return
      commit(isRepair ? 'repair.update' : 'mask.update', {
        id: item.id,
        changes: isAdjustment
          ? { adjustments: { [name]: Number(slider.value) } }
          : { [name]: Number(slider.value) }
      })
    }
  }
  const overlayVisible = element('input', {
    type: 'checkbox',
    checked: 'checked',
    'aria-label': 'Show mask overlay'
  })
  overlayVisible.checked = true
  field('Show overlay (O) ', overlayVisible)
  overlayVisible.onchange = () =>
    run('mask-overlay', { enabled: overlayVisible.checked }).catch((error) => notify(error.message))
  field('Invert ', invert)
  field('Enabled ', enabled)
  panel.append(choose, remove, status)
  container.append(panel)
  let source = null,
    picking = false,
    colorPicking = false,
    sampledClick = false,
    asset = '',
    mounted,
    cleanup = () => {},
    gesture = null,
    draft = null
  const rootItem = () => localToolAt(getActive()?.edit ?? {}, list.value)
  const selectedItem = () =>
    localToolAt(
      getActive()?.edit ?? {},
      list.value,
      component.value ? component.value.split('.').map(Number) : []
    )
  const commit = (command, args, context) => {
    if (command === 'mask.update' && component.value) {
      args = { ...args, id: list.value, path: component.value.split('.').map(Number) }
      command = 'mask.component-update'
    }
    return run(command, { ...args, photoId: args.photoId ?? getActive()?.id }, undefined, context).catch(
      (error) => notify(error.message)
    )
  }
  function sync(requestedPath) {
    const photo = getActive(),
      local = photo?.edit.localTools ?? {},
      previous = list.value
    blurEnabled.checked = local.lensBlur?.enabled ?? false
    if (local.lensBlur) for (const [name, input] of Object.entries(focus)) input.value = local.lensBlur[name]
    if (asset !== photo?.id) {
      asset = photo?.id
      source = null
      picking = false
      draft = null
      colorPicking = false
      sampledClick = false
    }
    const items = [...(local.masks ?? []), ...(local.repairs ?? [])]
    list.replaceChildren(
      element('option', { value: '' }, 'New stroke / gradient'),
      ...items.map((item, index) =>
        element(
          'option',
          { value: item.id },
          index +
            1 +
            '. ' +
            (item.type === 'semantic' ? (item.provenance?.target ?? 'semantic') + ' (AI)' : item.type) +
            (item.enabled === false ? ' (off)' : '')
        )
      )
    )
    if (items.some((item) => item.id === previous)) list.value = previous
    const oldPath = requestedPath ?? (component.dataset.root === list.value ? component.value : '')
    component.dataset.root = list.value
    const options = [element('option', { value: '' }, 'Whole mask')],
      walk = (tool, path = []) => {
        for (const [index, child] of (tool?.components ?? []).entries()) {
          const next = [...path, index]
          options.push(
            element(
              'option',
              { value: next.join('.') },
              next.map((value) => value + 1).join('.') + ' ' + child.type
            )
          )
          walk(child, next)
        }
      }
    walk(rootItem())
    component.replaceChildren(...options)
    component.hidden = options.length === 1
    if (options.some((option) => option.value === oldPath)) component.value = oldPath
    const item = selectedItem()
    remove.disabled = !item
    invert.disabled = !item || ['clone', 'heal'].includes(item.type)
    enabled.disabled = !item
    operation.disabled = item?.type !== 'composite'
    if (item?.operation) operation.value = item.operation
    const oldOperand = operand.value
    operand.replaceChildren(
      ...(local.masks ?? [])
        .filter((mask) => mask.id !== item?.id)
        .map((mask, index) => element('option', { value: mask.id }, index + 1 + '. ' + mask.type))
    )
    if ([...operand.options].some((option) => option.value === oldOperand)) operand.value = oldOperand
    for (const [name, input] of Object.entries(rangeInputs))
      if (item && Object.hasOwn(item, name)) input.value = item[name]
    invert.checked = item?.invert ?? false
    enabled.checked = item?.enabled ?? true
    for (const [name, input] of Object.entries(sliders)) {
      const isAdjustment = Object.hasOwn(LOCAL_CONTROLS, name),
        isRepair = item && ['clone', 'heal'].includes(item.type)
      input.disabled = Boolean(
        (isAdjustment && (isRepair || component.value)) ||
        (name === 'radius' && item && !['brush', 'clone', 'heal'].includes(item.type)) ||
        (name === 'feather' &&
          ['linear', 'semantic', 'depth-range', 'composite', 'color-range', 'luminance-range'].includes(
            item?.type ?? mode.value
          ))
      )
      if (item) {
        input.value = isAdjustment ? (item.adjustments?.[name] ?? 0) : (item[name] ?? input.value)
        input.previousElementSibling.value = input.value
      }
    }
    choose.hidden = !['clone', 'heal'].includes(mode.value)
    choose.textContent = picking ? 'Cancel source selection' : 'Choose repair source'
    if (mounted) drawOverlay()
  }
  const selection = () => ({
    id: list.value,
    path: component.value ? component.value.split('.').map(Number) : [],
    overlay: overlayVisible.checked
  })
  const select = (id, path = []) => {
    const local = getActive()?.edit.localTools
    let item = [...(local?.masks ?? []), ...(local?.repairs ?? [])].find((entry) => entry.id === id)
    if (id && !item) throw Error('Local adjustment not found')
    for (const index of path) {
      item = item?.components?.[index]
      if (!item) throw Error('Mask component not found')
    }
    list.value = id
    colorPicking = false
    sync(path.join('.'))
    if (mounted) mounted.canvas.style.cursor = mode.value === 'off' ? 'zoom-in' : 'crosshair'
    return selection()
  }
  const chooseAdjustment = (path) =>
    run('local-select', { id: list.value, path, photoId: getActive()?.id }).catch((error) =>
      notify(error.message)
    )
  list.onchange = () => chooseAdjustment([])
  component.onchange = () => chooseAdjustment(selection().path)
  mode.onchange = () => run('local-tool', { tool: mode.value }).catch((error) => notify(error.message))
  choose.onclick = () =>
    run('repair-source', { picking: !picking, photoId: getActive()?.id }).catch((error) =>
      notify(error.message)
    )
  remove.onclick = () => {
    const item = rootItem()
    if (item) commit(['clone', 'heal'].includes(item.type) ? 'repair.remove' : 'mask.remove', { id: item.id })
  }
  invert.onchange = () => {
    const item = selectedItem()
    if (item) commit('mask.update', { id: item.id, changes: { invert: invert.checked } })
  }
  enabled.onchange = () => {
    const item = selectedItem()
    if (item)
      commit(['clone', 'heal'].includes(item.type) ? 'repair.update' : 'mask.update', {
        id: item.id,
        changes: { enabled: enabled.checked }
      })
  }
  function svgNode(tag, attributes) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const [k, v] of Object.entries(attributes)) node.setAttribute(k, v)
    return node
  }
  function drawOverlay() {
    if (!mounted) return
    const { canvas, overlay, image, edit } = mounted,
      bounds = canvas.getBoundingClientRect()
    Object.assign(overlay.style, {
      left: bounds.left + 'px',
      top: bounds.top + 'px',
      width: bounds.width + 'px',
      height: bounds.height + 'px'
    })
    overlay.setAttribute('viewBox', '0 0 ' + bounds.width + ' ' + bounds.height)
    overlay.replaceChildren()
    const project = (p) => {
      const q = originalToView(p, image, edit)
      return { x: q.x * bounds.width, y: q.y * bounds.height }
    }
    const path = (points) => {
      let connected = false
      return points
        .map((p) => {
          const q = project(p)
          if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) {
            connected = false
            return ''
          }
          const result = (connected ? 'L' : 'M') + q.x + ' ' + q.y
          connected = true
          return result
        })
        .join(' ')
    }
    const circle = (p) => {
      const q = project(p)
      if (Number.isFinite(q.x) && Number.isFinite(q.y))
        overlay.append(
          svgNode('circle', { cx: q.x, cy: q.y, r: 5, fill: 'none', stroke: '#59d9ff', 'stroke-width': 2 })
        )
    }
    const tool = draft?.tool ?? selectedItem()
    if (tool && !['clone', 'heal'].includes(tool.type)) {
      if (!overlayVisible.checked) return
      const small = maskCoverageSource(image, edit, tool, { maxEdge: 384 }),
        raster = { width: small.width, height: small.height }
      const view = document.createElement('canvas')
      view.width = Math.max(1, Math.round(bounds.width))
      view.height = Math.max(1, Math.round(bounds.height))
      const g = geometry(image, edit),
        ctx = view.getContext('2d'),
        w = g.turn % 2 ? view.height : view.width,
        h = g.turn % 2 ? view.width : view.height
      ctx.translate(view.width / 2, view.height / 2)
      ctx.rotate((g.turn * Math.PI) / 2)
      ctx.scale(g.flip ? -1 : 1, 1)
      const corrected = renderOpticsSource(
        small,
        { ...edit.optics, profileTCA: false, redScale: 0, blueScale: 0 },
        image
      )
      ctx.drawImage(
        corrected,
        (g.x / image.width) * raster.width,
        (g.y / image.height) * raster.height,
        (g.w / image.width) * raster.width,
        (g.h / image.height) * raster.height,
        -w / 2,
        -h / 2,
        w,
        h
      )
      overlay.append(
        svgNode('image', {
          href: view.toDataURL(),
          x: 0,
          y: 0,
          width: bounds.width,
          height: bounds.height,
          opacity: 0.3,
          preserveAspectRatio: 'none'
        })
      )
    } else if (tool?.type === 'linear')
      overlay.append(
        svgNode('path', {
          d: path([tool.start, tool.end]),
          stroke: '#ffb15c',
          'stroke-width': 2,
          fill: 'none'
        })
      )
    else if (tool?.type === 'radial') {
      const points = Array.from({ length: 65 }, (_, i) => ({
        x: tool.center.x + Math.cos((i * Math.PI) / 32) * tool.rx,
        y: tool.center.y + Math.sin((i * Math.PI) / 32) * tool.ry
      }))
      overlay.append(svgNode('path', { d: path(points), stroke: '#ffb15c', 'stroke-width': 2, fill: 'none' }))
    } else if (tool?.points) {
      const g = geometry(image, edit),
        scale = Math.min(bounds.width / (g.turn % 2 ? g.h : g.w), bounds.height / (g.turn % 2 ? g.w : g.h))
      overlay.append(
        svgNode('path', {
          d: path(
            tool.points.length === 1
              ? [tool.points[0], { x: tool.points[0].x + 0.00001, y: tool.points[0].y }]
              : tool.points
          ),
          stroke: '#ffb15c',
          'stroke-width': Math.max(2, tool.radius * Math.min(image.width, image.height) * scale * 2),
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          opacity: 0.45,
          fill: 'none'
        })
      )
    }
    const shownSource = draft && ['clone', 'heal'].includes(tool?.type) ? tool.source : source
    if (shownSource) circle(shownSource)
  }
  function ownsGesture(candidate) {
    const photo = getActive()
    return Boolean(
      photo &&
      candidate &&
      !candidate.canceled &&
      candidate.surface === mounted &&
      candidate.photoId === photo?.id &&
      candidate.surface.edit === photo.edit
    )
  }
  function ownsDraft(record) {
    const photo = getActive()
    return Boolean(
      record &&
      record.surface === mounted &&
      record.state.photoId === photo?.id &&
      record.surface.edit === photo.edit &&
      record.surface.canvas.isConnected
    )
  }
  function draftState() {
    return ownsDraft(draft)
      ? structuredClone({ ...draft.state, visible: Boolean(mounted.overlay.childElementCount) })
      : null
  }
  function stageDraft(command, args, tool, origin) {
    const photo = getActive()
    if (origin && !ownsGesture(origin)) return null
    if (!mounted || mounted.edit !== photo?.edit || mode.value !== tool.type) {
      if (origin) return null
      throw Error(LOCAL_DRAFT_MESSAGES.tool)
    }
    const { draft: _, ...change } = args
    if (!origin) cancelGesture(false)
    else if (draft?.gesture && draft.gesture !== origin) draft.gesture.canceled = true
    draft = {
      surface: mounted,
      gesture: origin,
      tool,
      state: {
        id: crypto.randomUUID(),
        photoId: photo.id,
        command,
        args: structuredClone({ ...change, [command.split('.')[0]]: tool, photoId: photo.id }),
        status: 'ready'
      }
    }
    try {
      drawOverlay()
    } catch (error) {
      draft = null
      throw error
    }
    return draftState()
  }
  function currentDraft(id) {
    if (!ownsDraft(draft) || draft.state.id !== id) throw Error(LOCAL_DRAFT_MESSAGES.changed)
    return draft
  }
  function takeDraft(id) {
    const state = currentDraft(id).state
    cancelGesture()
    return state
  }
  async function draftImage(id) {
    const record = currentDraft(id),
      { overlay } = record.surface
    const viewBox = overlay.getAttribute('viewBox')
    const { width, height } = overlay.viewBox.baseVal
    const snapshot = overlay.cloneNode(true)
    const children = [...snapshot.children]
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width))
    canvas.height = Math.max(1, Math.round(height))
    const ctx = canvas.getContext('2d')
    // SVG loaded as an image can paint before its embedded PNG is ready.
    // Decode the published raster directly, then draw the published vectors over it.
    const raster = snapshot.querySelector('image')
    if (raster && width > 0 && height > 0) {
      raster.remove()
      const image = new Image()
      image.src = raster.getAttribute('href')
      await image.decode()
      const scale = Math.min(canvas.width / width, canvas.height / height)
      const w = width * scale,
        h = height * scale
      ctx.globalAlpha = Number(raster.getAttribute('opacity'))
      ctx.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
      ctx.globalAlpha = 1
    }
    snapshot.removeAttribute('style')
    snapshot.setAttribute('width', canvas.width)
    snapshot.setAttribute('height', canvas.height)
    if (snapshot.childElementCount && width > 0 && height > 0) {
      const url = URL.createObjectURL(
        new Blob([new XMLSerializer().serializeToString(snapshot)], { type: 'image/svg+xml' })
      )
      try {
        const image = new Image()
        image.src = url
        await image.decode()
        ctx.drawImage(image, 0, 0)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    const blob = await toBlob(canvas, 'image/png')
    if (
      currentDraft(id) !== record ||
      overlay.getAttribute('viewBox') !== viewBox ||
      overlay.childElementCount !== children.length ||
      !children.every((child, index) => child.isEqualNode(overlay.children[index]))
    )
      throw Error(LOCAL_DRAFT_MESSAGES.changed)
    return { blob, filename: 'local-stroke-draft.png' }
  }
  function cancelGesture(redraw = true) {
    const previous = gesture
    const canceled = Boolean(gesture || draft)
    if (previous) previous.canceled = true
    if (draft?.gesture) draft.gesture.canceled = true
    gesture = draft = null
    if (previous && mounted?.canvas.hasPointerCapture(previous.pointerId))
      mounted.canvas.releasePointerCapture(previous.pointerId)
    if (canceled && mounted && redraw) drawOverlay()
    return canceled
  }
  function unmount() {
    cancelGesture()
    picking = false
    choose.textContent = 'Choose repair source'
    cleanup()
    cleanup = () => {}
    mounted = null
  }
  function mount(canvas, { image, edit, enabled: available = true }) {
    unmount()
    if (!available) return
    const overlay = svgNode('svg', { 'aria-hidden': 'true', class: 'local-overlay' })
    Object.assign(overlay.style, { position: 'fixed', pointerEvents: 'none', zIndex: 5, overflow: 'hidden' })
    document.body.append(overlay)
    mounted = { canvas, overlay, image, edit }
    canvas.style.cursor = mode.value === 'off' && !colorPicking ? 'zoom-in' : 'crosshair'
    const point = (event) => {
      const r = canvas.getBoundingClientRect()
      return viewToOriginal(
        { x: clamp((event.clientX - r.left) / r.width), y: clamp((event.clientY - r.top) / r.height) },
        image,
        edit
      )
    }
    const down = (event) => {
      if ((mode.value === 'off' && !colorPicking) || event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const p = point(event),
        repair = ['clone', 'heal'].includes(mode.value)
      if (!p) {
        status.textContent = 'Choose a point inside the corrected source image.'
        return
      }
      if (colorPicking) {
        sampledClick = true
        const { id, path } = selection()
        run('range-color', { x: p.x, y: p.y, photoId: getActive()?.id, id, path }).catch((error) =>
          notify(error.message)
        )
        return
      }
      if (repair && (picking || event.altKey || !source)) {
        run('repair-source', { point: p, photoId: getActive()?.id }).catch((error) => notify(error.message))
        return
      }
      if (gesture && !gesture.released) return
      gesture = {
        photoId: getActive()?.id,
        surface: mounted,
        start: p,
        points: [p],
        pointerId: event.pointerId,
        type: mode.value
      }
      canvas.setPointerCapture(event.pointerId)
      stageGesture(p)
    }
    function gestureTool(end) {
      const base = {
        type: gesture.type,
        opacity: Number(sliders.opacity.value),
        feather: Number(sliders.feather.value)
      }
      let tool
      if (base.type === 'linear') tool = { ...base, start: gesture.start, end }
      else if (base.type === 'radial')
        tool = {
          ...base,
          center: gesture.start,
          rx: Math.max(0.00001, Math.abs(end.x - gesture.start.x)),
          ry: Math.max(0.00001, Math.abs(end.y - gesture.start.y))
        }
      else
        tool = {
          ...base,
          points: [...gesture.points],
          radius: Number(sliders.radius.value),
          ...(['clone', 'heal'].includes(base.type) ? { source } : {})
        }
      if (!['clone', 'heal'].includes(base.type)) tool.adjustments = {}
      return tool
    }
    function gestureDistance(tool) {
      return Math.hypot(tool.end.x - tool.start.x, tool.end.y - tool.start.y)
    }
    function gestureCommand(tool, staging) {
      const kind = ['clone', 'heal'].includes(tool.type) ? 'repair' : 'mask'
      return commit(
        kind + '.add',
        { [kind]: tool, photoId: gesture.photoId, ...(staging && { draft: true }) },
        { localGesture: gesture }
      )
    }
    function stageGesture(end) {
      const tool = gestureTool(end)
      if (tool.type !== 'linear' || gestureDistance(tool) >= 1e-8) gestureCommand(tool, true)
    }
    const move = (event) => {
      if (!gesture || gesture.released || event.pointerId !== gesture.pointerId) return
      event.preventDefault()
      event.stopPropagation()
      const p = point(event),
        previous = gesture.points.at(-1)
      if (!p) return
      if (Math.hypot(p.x - previous.x, p.y - previous.y) > 0.001) gesture.points.push(p)
      stageGesture(p)
    }
    const up = (event) => {
      if (!gesture || gesture.released || event.pointerId !== gesture.pointerId) return
      event.preventDefault()
      event.stopPropagation()
      const end = point(event)
      if (!end) {
        if (cancelGesture()) onDraftChange()
        return
      }
      const tool = gestureTool(end),
        current = gesture
      if (tool.type === 'linear' && gestureDistance(tool) < 0.002) {
        if (cancelGesture()) onDraftChange()
        return
      }
      current.released = true
      canvas.releasePointerCapture(event.pointerId)
      gestureCommand(tool, false).finally(() => {
        if ((gesture === current || draft?.gesture === current) && cancelGesture()) onDraftChange()
      })
    }
    const cancel = (event) => {
      if (event.pointerId === gesture?.pointerId && !gesture.released && cancelGesture()) onDraftChange()
    }
    const click = (event) => {
      if (mode.value !== 'off' || colorPicking || sampledClick) {
        sampledClick = false
        event.stopPropagation()
        event.preventDefault()
      }
    }
    for (const [type, handler] of Object.entries({
      pointerdown: down,
      pointermove: move,
      pointerup: up,
      pointercancel: cancel,
      lostpointercapture: cancel,
      click
    }))
      canvas.addEventListener(type, handler)
    const observer = new ResizeObserver(drawOverlay)
    observer.observe(canvas)
    window.addEventListener('scroll', drawOverlay, true)
    window.addEventListener('resize', drawOverlay)
    cleanup = () => {
      observer.disconnect()
      overlay.remove()
      for (const [type, handler] of Object.entries({
        pointerdown: down,
        pointermove: move,
        pointerup: up,
        pointercancel: cancel,
        lostpointercapture: cancel,
        click
      }))
        canvas.removeEventListener(type, handler)
      window.removeEventListener('scroll', drawOverlay, true)
      window.removeEventListener('resize', drawOverlay)
    }
    drawOverlay()
  }
  sync()
  function setMode(value) {
    cancelGesture()
    const sample = value === 'color-sample'
    mode.value = sample ? 'off' : value
    picking = false
    draft = null
    if (!sample) list.value = ''
    sync()
    colorPicking = sample
    status.textContent = sample
      ? 'Click the image to sample the original color.'
      : ['clone', 'heal'].includes(value)
        ? 'Alt-click or choose a source, then drag the target.'
        : 'Drag to create a new ' + mode.options[mode.selectedIndex].text + '.'
    if (mounted) mounted.canvas.style.cursor = value === 'off' ? 'zoom-in' : 'crosshair'
    panel.open = value !== 'off'
  }
  const setRangeColor = (color) => {
    rangeInputs.color.value = color
    colorPicking = false
    if (mounted) mounted.canvas.style.cursor = mode.value === 'off' ? 'zoom-in' : 'crosshair'
    status.textContent = 'Original color sampled. Create or refine a color range.'
  }
  const selectMask = (id, { finishDrawing = false } = {}) => {
    if (finishDrawing) {
      cancelGesture()
      mode.value = 'off'
      picking = false
    }
    overlayVisible.checked = true
    select(id)
  }
  const setOverlay = (enabled) => {
    overlayVisible.checked = enabled ?? !overlayVisible.checked
    if (mounted) drawOverlay()
    return overlayVisible.checked
  }
  const repairSource = () => ({ point: source ? { ...source } : null, picking })
  function setRepairSource(args) {
    if (!['clone', 'heal'].includes(mode.value)) throw Error('Select Clone or Heal texture first')
    cancelGesture()
    if (args.point !== undefined) {
      source = { ...args.point }
      picking = false
    } else picking = args.picking
    choose.textContent = picking ? 'Cancel source selection' : 'Choose repair source'
    status.textContent = picking
      ? 'Click the image to choose the source.'
      : source
        ? 'Source selected. Drag the target to apply.'
        : 'Choose a source, then drag the target.'
    if (mounted) drawOverlay()
    return repairSource()
  }
  return {
    repairSource,
    setRepairSource,
    sync,
    mount,
    cancelGesture,
    ownsGesture,
    stageDraft,
    draftState,
    hasDraftId: (id) => ownsDraft(draft) && draft.state.id === id,
    takeDraft,
    draftImage,
    hasDraft: () => Boolean(gesture || draft),
    setMode,
    getMode: () => (colorPicking ? 'color-sample' : mode.value),
    setRangeColor,
    rangeColor: () => rangeInputs.color.value,
    unmount,
    selectMask,
    setOverlay,
    selection,
    select,
    selectedItem,
    active: () => mode.value !== 'off' || colorPicking,
    deactivate: () => setMode('off'),
    panel
  }
}
