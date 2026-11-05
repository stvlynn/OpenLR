// Shared visibility boundary for disk-backed and invalidated catalog previews.
export function whenVisible(element, load, onDone = () => {}) {
  if (typeof IntersectionObserver === 'undefined') {
    // Tile construction precedes attachment to its container.
    queueMicrotask(load)
    return null
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect()
        onDone(observer)
        load()
      }
    },
    { rootMargin: '120px' }
  )
  observer.observe(element)
  return observer
}
