export function validatePoint(point) {
  if (!point || typeof point.id !== 'string' || !/^#[0-9a-f]{6}$/i.test(point.color))
    throw Error('Choose an sRGB sample color')
  for (const key of ['hue', 'saturation', 'luminance', 'range']) {
    const limit = key === 'hue' ? 180 : 100
    if (
      typeof point[key] !== 'number' ||
      !Number.isFinite(point[key]) ||
      point[key] > limit ||
      point[key] < (key === 'range' ? 0 : -limit)
    )
      throw Error('Invalid point color ' + key)
  }
  return {
    id: point.id,
    color: point.color.toLowerCase(),
    hue: point.hue,
    saturation: point.saturation,
    luminance: point.luminance,
    range: point.range
  }
}
export function sampleColor(canvas, x, y) {
  const px = Math.max(0, Math.min(canvas.width - 1, Math.floor(x * canvas.width))),
    py = Math.max(0, Math.min(canvas.height - 1, Math.floor(y * canvas.height)))
  const rgb = canvas.getContext('2d').getImageData(px, py, 1, 1).data
  return '#' + Array.from(rgb.slice(0, 3), (n) => n.toString(16).padStart(2, '0')).join('')
}
export function pointPanel(run) {
  const panel = document.createElement('details'),
    summary = document.createElement('summary'),
    select = document.createElement('select')
  summary.textContent = 'Point color'
  select.setAttribute('aria-label', 'Color sample')
  panel.append(summary, select)
  const sample = document.createElement('button')
  sample.textContent = 'Sample color'
  sample.onclick = () => run('point-tool')
  panel.append(sample)
  const inputs = {}
  for (const key of ['hue', 'saturation', 'luminance', 'range']) {
    const input = document.createElement('input'),
      label = document.createElement('label'),
      output = document.createElement('output')
    input.type = 'range'
    input.min = key === 'range' ? 0 : key === 'hue' ? -180 : -100
    input.max = key === 'hue' ? 180 : 100
    input.setAttribute('aria-label', 'Point ' + key)
    label.append(key[0].toUpperCase() + key.slice(1), output, input)
    panel.append(label)
    input.oninput = () => (output.value = input.value)
    input.onchange = () => run('point-update', { id: select.value, [key]: Number(input.value) })
    inputs[key] = { input, output }
  }
  const remove = document.createElement('button')
  remove.textContent = 'Delete sample'
  remove.onclick = () => run('point-remove', { id: select.value })
  panel.append(remove)
  document.getElementById('adjustments').after(panel)
  let points = []
  function update() {
    const p = points.find((p) => p.id === select.value)
    for (const [key, { input, output }] of Object.entries(inputs)) {
      input.disabled = !p
      input.value = p?.[key] ?? (key === 'range' ? 15 : 0)
      output.value = input.value
    }
    remove.disabled = !p
  }
  select.onchange = update
  return (values = [], latest) => {
    const last = latest || select.value
    points = values
    select.replaceChildren(...points.map((p) => new Option(p.color, p.id)))
    if (points.some((p) => p.id === last)) select.value = last
    update()
  }
}
export function clippingOverlay(canvas) {
  const ctx = canvas.getContext('2d'),
    pixels = ctx.getImageData(0, 0, canvas.width, canvas.height),
    d = pixels.data
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] && Math.max(d[i], d[i + 1], d[i + 2]) === 255) {
      d[i] = 255
      d[i + 1] = 0
      d[i + 2] = 0
    } else if (d[i + 3] && Math.max(d[i], d[i + 1], d[i + 2]) === 0) {
      d[i] = 0
      d[i + 1] = 48
      d[i + 2] = 255
    }
  }
  ctx.putImageData(pixels, 0, 0)
}
