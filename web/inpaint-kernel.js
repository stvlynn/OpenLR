import { openCV } from './cv-runtime.js'
import { localWeight } from './local-tools.js'
import { deflateSync } from './vendor/fflate/browser.js'
export async function makeFill({ pixels, reference = pixels, mask, algorithm = 'telea', radius = 3 }) {
  const cv = await openCV(),
    { width, height, data } = pixels
  const rgb = new cv.Mat(height, width, cv.CV_8UC3),
    selection = new cv.Mat(height, width, cv.CV_8UC1),
    output = new cv.Mat()
  try {
    let x0 = width,
      y0 = height,
      x1 = 0,
      y1 = 0,
      count = 0
    const opacity = new Uint8ClampedArray(width * height)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        const start = i * 4,
          end = start + 3
        rgb.data.set(data.subarray(start, end), i * 3)
        const weight = localWeight(
          mask,
          (x + 0.5) / width,
          (y + 0.5) / height,
          width,
          height,
          reference?.data.subarray(start, end),
          reference?.colorSpace
        )
        opacity[i] = weight * 255
        selection.data[i] = opacity[i] ? 255 : 0
        if (opacity[i]) {
          x0 = Math.min(x0, x)
          y0 = Math.min(y0, y)
          x1 = Math.max(x1, x + 1)
          y1 = Math.max(y1, y + 1)
          count++
        }
      }
    if (!count || count === width * height) throw Error('Select an area with surrounding pixels')
    cv.inpaint(rgb, selection, output, radius, algorithm === 'ns' ? cv.INPAINT_NS : cv.INPAINT_TELEA)
    const w = x1 - x0,
      h = y1 - y0,
      rgba = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y + y0) * width + x + x0,
          dest = (y * w + x) * 4
        if (!opacity[i]) continue
        rgba.set(output.data.subarray(i * 3, i * 3 + 3), dest)
        rgba[dest + 3] = opacity[i]
      }
    const packed = deflateSync(rgba),
      chunks = []
    for (let i = 0; i < packed.length; i += 32768)
      chunks.push(String.fromCharCode(...packed.subarray(i, i + 32768)))
    return {
      patch: {
        x: x0 / width,
        y: y0 / height,
        w: w / width,
        h: h / height,
        width: w,
        height: h,
        rgba: btoa(chunks.join('')),
        algorithm,
        radius
      }
    }
  } finally {
    rgb.delete()
    selection.delete()
    output.delete()
  }
}
