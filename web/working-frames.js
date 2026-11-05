// Associates a disposable display surface with its precise source samples.
// Consumers doing model analysis may use the surface; rendering uses the frame.
const frames = new WeakMap()
export function bindWorkingFrame(surface, frame) {
  frames.set(surface, frame)
  return surface
}
export function workingFrame(surface) {
  return frames.get(surface)
}
