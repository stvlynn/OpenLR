export function displayedPhotos(list, open) {
  const covers = new Map(),
    seen = new Set()
  for (const p of list) if (p.stackId && (!covers.has(p.stackId) || p.stackCover)) covers.set(p.stackId, p)
  return list.flatMap((p) => {
    if (!p.stackId || open.has(p.stackId)) return [p]
    if (seen.has(p.stackId)) return []
    seen.add(p.stackId)
    return [covers.get(p.stackId)]
  })
}
async function signature(photo) {
  const img = await createImageBitmap(photo.thumbnail)
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 12
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0, 12, 12)
    return g.getImageData(0, 0, 12, 12).data
  } finally {
    img.close()
  }
}
function difference(a, b) {
  let d = 0
  for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) d += Math.abs(a[i + k] - b[i + k])
  return d / (a.length * 0.75 * 255)
}
export async function findStacks(photos, by, threshold) {
  const capture = (p) => Date.parse(p.metadata?.DateTimeOriginal) || p.captured || p.added
  const list = photos.filter((p) => !p.deleted && !p.stackId).sort((a, b) => capture(a) - capture(b))
  const groups = []
  if (by === 'time') {
    for (const p of list) {
      const group = groups.at(-1)
      if (group && (capture(p) - capture(group[0])) / 1000 <= threshold) group.push(p)
      else groups.push([p])
    }
  } else {
    const signatures = []
    for (const p of list) {
      const sig = await signature(p)
      const index = signatures.findIndex((s) => difference(s, sig) <= threshold)
      if (index < 0) {
        signatures.push(sig)
        groups.push([p])
      } else groups[index].push(p)
    }
  }
  return groups.filter((group) => group.length > 1)
}
export function smartMatch(photo, rule) {
  if (!rule) return false
  const text = [
    photo.name,
    photo.keywords,
    photo.metadata?.Make,
    photo.metadata?.Model,
    photo.metadata?.LensModel
  ]
    .join(' ')
    .toLowerCase()
  return (
    photo.rating >= rule.rating &&
    (rule.flag === 'any' || photo.flag === (rule.flag === 'unflagged' ? '' : rule.flag)) &&
    (!rule.text || text.includes(rule.text.toLowerCase())) &&
    (rule.edited === 'any' ||
      Object.keys(photo.edit).some((key) => Boolean(photo.edit[key])) === (rule.edited === 'yes'))
  )
}
export function stackMenu(run) {
  const details = document.createElement('details'),
    summary = document.createElement('summary'),
    menu = document.createElement('div')
  details.id = 'photo-menu'
  summary.textContent = 'Photo'
  details.append(summary, menu)
  const actions = [
    ['Stack selected', 'stack'],
    ['Open or close stack', 'stack-toggle'],
    ['Set stack cover', 'stack-cover'],
    ['Ungroup stack', 'unstack'],
    ['Stack by capture time…', 'auto-stack-time'],
    ['Stack visually similar…', 'auto-stack-similar'],
    ['Invert selection', 'select-inverse'],
    ['Review focus and exposure', 'cull'],
    ['Correct red eyes', 'red-eye'],
    ['Create virtual copy', 'virtual-copy'],
    ['Save frame as photo', 'save-frame'],
    ['Start slideshow', 'slideshow']
  ]
  for (const [label, action] of actions) {
    const b = document.createElement('button')
    b.textContent = label
    b.dataset.action = action
    b.onclick = () => {
      details.open = false
      if (action.startsWith('auto-stack-')) {
        const t = action.endsWith('time'),
          dialog = document.getElementById('stack-dialog')
        const input = dialog.querySelector('input')
        dialog.dataset.by = t ? 'time' : 'similarity'
        dialog.querySelector('label span').textContent = t
          ? 'Interval (seconds)'
          : 'Maximum color difference (%)'
        input.value = t ? 5 : 7
        input.max = t ? '86400' : '100'
        dialog.showModal()
      } else run(action)
    }
    menu.append(b)
  }
  document.querySelector('.bar').append(details)
  const dialog = document.getElementById('stack-dialog')
  dialog.onclose = () => {
    if (dialog.returnValue === 'ok') {
      const by = dialog.dataset.by,
        threshold = Number(dialog.querySelector('input').value) / (by === 'time' ? 1 : 100)
      run('auto-stack', { by, threshold })
    }
    dialog.returnValue = ''
  }
  return (state) => {
    const p = state.photos.find((p) => p.id === state.selected)
    for (const b of menu.children) {
      const action = b.dataset.action
      b.disabled =
        action === 'save-frame'
          ? !p?.duration
          : action === 'stack'
            ? Boolean(state.local) || state.selection.length < 2
            : ['stack-cover', 'unstack', 'stack-toggle'].includes(action)
              ? !p?.stackId
              : action.startsWith('auto-stack-')
                ? Boolean(state.local) || state.photos.length < 2
                : action === 'virtual-copy'
                  ? Boolean(state.local) || !p
                  : !state.photos.length
    }
  }
}
