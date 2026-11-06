// Viewport coordinates belong to the display adapter, not the photo recipe.
export const VIEWPORT_MESSAGES = {
  detail: 'Open a photo in detail view',
  grid: 'Open Grid view',
  filmstrip: 'Show the filmstrip in detail view',
  changed: 'The selected photo changed'
}

export function readViewport(stage) {
  return {
    x: stage.scrollLeft,
    y: stage.scrollTop,
    width: stage.clientWidth,
    height: stage.clientHeight,
    maxX: Math.max(0, stage.scrollWidth - stage.clientWidth),
    maxY: Math.max(0, stage.scrollHeight - stage.clientHeight)
  }
}

export function moveViewport(stage, { x, y }) {
  const current = readViewport(stage)
  stage.scrollTo({
    left: Math.min(current.maxX, x ?? current.x),
    top: Math.min(current.maxY, y ?? current.y),
    behavior: 'instant'
  })
  return readViewport(stage)
}
