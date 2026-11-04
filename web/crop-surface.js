import { geometry } from './geometry.js'
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
export class CropSurface {
  constructor(stage, finish, notify) {
    this.stage = stage
    this.finish = finish
    this.changed = false
    stage.addEventListener('pointerdown', (e) => this.start(e))
    stage.addEventListener('pointermove', (e) => this.move(e))
    stage.addEventListener('pointerup', (e) => {
      if (this.drag && e.pointerId === this.drag.pointer) {
        const moved = this.drag.box !== this.box
        this.drag = null
        if (moved) notify()
      }
    })
    stage.addEventListener('pointercancel', () => {
      if (this.drag) {
        this.box = this.drag.box
        this.changed = this.drag.changed
        this.drag = null
        this.draw()
      }
    })
    stage.addEventListener('dblclick', () => {
      if (this.frame?.isConnected) this.finish()
    })
    new ResizeObserver(() => this.draw()).observe(stage)
  }
  reset() {
    this.owner = null
    this.changed = false
    this.drag = null
    this.frame?.remove()
    this.frame = null
  }
  mount(canvas, image, edit, id) {
    const shape = geometry(image, edit)
    if (this.owner !== id || this.aspect !== edit.aspect) {
      this.box = {
        x: shape.x / image.width,
        y: shape.y / image.height,
        w: shape.w / image.width,
        h: shape.h / image.height
      }
      this.changed = false
      this.owner = id
      this.aspect = edit.aspect
    }
    this.ratio = (Number(edit.aspect) * image.height) / image.width || 0
    this.canvas = canvas
    const frame = document.createElement('div')
    frame.className = 'crop-surface'
    frame.setAttribute('aria-label', 'Crop rectangle')
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const grip = document.createElement('i')
      grip.dataset.grip = handle
      frame.append(grip)
    }
    this.frame = frame
    this.stage.append(frame)
    this.draw()
  }
  draw() {
    if (!this.frame?.isConnected) return
    const image = this.canvas.getBoundingClientRect(),
      stage = this.stage.getBoundingClientRect(),
      r = this.box
    Object.assign(this.frame.style, {
      left: image.left - stage.left + r.x * image.width + 'px',
      top: image.top - stage.top + r.y * image.height + 'px',
      width: r.w * image.width + 'px',
      height: r.h * image.height + 'px'
    })
  }
  point(e) {
    const b = this.canvas.getBoundingClientRect()
    return { x: clamp((e.clientX - b.left) / b.width, 0, 1), y: clamp((e.clientY - b.top) / b.height, 0, 1) }
  }
  start(e) {
    if (
      e.button !== 0 ||
      !this.frame?.isConnected ||
      (!this.frame.contains(e.target) && e.target !== this.canvas)
    )
      return
    const p = this.point(e),
      box = this.box,
      full = box.w > 0.999 && box.h > 0.999
    const grip = e.target.dataset.grip || (e.target === this.canvas || full ? 'new' : 'move')
    this.drag = { pointer: e.pointerId, p, box, grip, changed: this.changed }
    this.stage.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  move(e) {
    if (!this.drag || e.pointerId !== this.drag.pointer) return
    const { p, box, grip } = this.drag
    this.reshape(box, grip, p, this.point(e), e.shiftKey)
  }
  reshape(box, grip, p, q, lockAspect) {
    if (grip === 'move') {
      this.box = {
        ...box,
        x: clamp(box.x + q.x - p.x, 0, 1 - box.w),
        y: clamp(box.y + q.y - p.y, 0, 1 - box.h)
      }
    } else {
      let left = box.x,
        right = box.x + box.w,
        top = box.y,
        bottom = box.y + box.h
      if (grip === 'new') {
        left = Math.min(p.x, q.x)
        right = Math.max(p.x, q.x)
        top = Math.min(p.y, q.y)
        bottom = Math.max(p.y, q.y)
      }
      if (grip.includes('w') && grip !== 'new') left = clamp(q.x, 0, right - 0.001)
      if (grip.includes('e') && grip !== 'new') right = clamp(q.x, left + 0.001, 1)
      if (grip.includes('n') && grip !== 'new') top = clamp(q.y, 0, bottom - 0.001)
      if (grip.includes('s')) bottom = clamp(q.y, top + 0.001, 1)
      let w = right - left,
        h = bottom - top
      const ratio = this.ratio || (lockAspect ? box.w / box.h : 0)
      if (ratio) {
        const growLeft = grip === 'new' ? q.x < p.x : grip.includes('w')
        const growUp = grip === 'new' ? q.y < p.y : grip.includes('n')
        const maxW = growLeft ? right : 1 - left,
          maxH = growUp ? bottom : 1 - top
        w = Math.min(grip === 'n' || grip === 's' ? h * ratio : w, maxW, maxH * ratio)
        h = w / ratio
        if (growLeft) left = right - w
        if (growUp) top = bottom - h
      }
      if (w <= 0.001 || h <= 0.001) return
      this.box = { x: left, y: top, w, h }
    }
    this.changed = true
    this.draw()
  }
  nudge(dx, dy) {
    this.box = {
      ...this.box,
      x: clamp(this.box.x + dx / this.canvas.width, 0, 1 - this.box.w),
      y: clamp(this.box.y + dy / this.canvas.height, 0, 1 - this.box.h)
    }
    this.changed = true
    this.draw()
  }
}
