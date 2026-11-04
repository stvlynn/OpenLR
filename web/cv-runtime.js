let runtime
export function openCV() {
  return (runtime ??= (async () => {
    await import('./vendor/opencv/opencv.js')
    return await globalThis.cv
  })())
}
