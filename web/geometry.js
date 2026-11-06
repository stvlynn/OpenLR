// Crop rectangles are fractions of the optics-corrected base canvas, before
// reflection and 90-degree rotation. Its bounds retain the original dimensions.
export function geometry(image, edit = {}, maxSize = Infinity) {
  const box = edit.crop || { x: 0, y: 0, w: 1, h: 1 }
  const boxW = box.w * image.width,
    boxH = box.h * image.height
  const ratio = Number(edit.aspect)
  // Keep the exact crop bounds when no aspect is requested. A ratio round trip
  // can otherwise move a full-image crop outside the source rectangle.
  const w = ratio ? Math.min(boxW, boxH * ratio) : boxW,
    h = ratio ? Math.min(boxH, boxW / ratio) : boxH
  const scale = Math.min(1, maxSize / Math.max(w, h))
  return {
    x: box.x * image.width + (boxW - w) / 2,
    y: box.y * image.height + (boxH - h) / 2,
    w,
    h,
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    turn: edit.turn || 0,
    flip: Boolean(edit.flip)
  }
}
export function validCrop(box) {
  return (
    box &&
    ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(box[key])) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.w > 0 &&
    box.h > 0 &&
    box.x + box.w <= 1.00000001 &&
    box.y + box.h <= 1.00000001
  )
}
