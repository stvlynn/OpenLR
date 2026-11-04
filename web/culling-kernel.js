import { openCV } from './cv-runtime.js'
let modelReady
async function installModel(cv) {
  return (modelReady ??= (async () => {
    const response = await fetch(new URL('./models/yunet.onnx', import.meta.url))
    if (!response.ok) throw Error('Cannot load the face detector')
    cv.FS_createDataFile(
      '/',
      'openlr-yunet.onnx',
      new Uint8Array(await response.arrayBuffer()),
      true,
      false,
      false
    )
  })().catch((e) => {
    modelReady = null
    throw e
  }))
}
function detailScore(gray, w, h, x0 = 1, y0 = 1, x1 = w - 1, y1 = h - 1) {
  let sum = 0,
    squares = 0,
    n = 0
  for (let y = Math.max(1, Math.floor(y0)); y < Math.min(h - 1, Math.ceil(y1)); y++)
    for (let x = Math.max(1, Math.floor(x0)); x < Math.min(w - 1, Math.ceil(x1)); x++) {
      const i = y * w + x,
        v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]
      sum += v
      squares += v * v
      n++
    }
  return n ? Math.round(100 * Math.max(0, squares / n - (sum / n) ** 2)) / 100 : 0
}
export async function evaluatePhoto({ pixels }) {
  const cv = await openCV()
  await installModel(cv)
  const { width: w, height: h, data } = pixels
  const mat = cv.matFromImageData(pixels),
    bgr = new cv.Mat(),
    output = new cv.Mat()
  let detector
  try {
    cv.cvtColor(mat, bgr, cv.COLOR_RGBA2BGR)
    detector = new cv.FaceDetectorYN('/openlr-yunet.onnx', '', new cv.Size(w, h), 0.8, 0.3, 5000)
    detector.detect(bgr, output)
    const gray = new Uint8Array(w * h)
    let black = 0,
      white = 0
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.round(0.2126 * data[4 * i] + 0.7152 * data[4 * i + 1] + 0.0722 * data[4 * i + 2])
      if (gray[i] <= 3) black++
      if (gray[i] >= 252) white++
    }
    const faces = []
    for (let i = 0; i < output.rows; i++) {
      const row = output.data32F.subarray(i * 15, i * 15 + 15)
      const [x, y, width, height, rx, ry, lx, ly] = row,
        confidence = row[14]
      const radius = Math.max(1, Math.hypot(lx - rx, ly - ry) * 0.15)
      const eyes = [
        [rx, ry],
        [lx, ly]
      ].map(([x, y]) => ({
        x: x / w,
        y: y / h,
        rx: radius / w,
        ry: radius / h,
        detail: detailScore(gray, w, h, x - radius * 2, y - radius * 2, x + radius * 2, y + radius * 2)
      }))
      faces.push({ x: x / w, y: y / h, w: width / w, h: height / h, confidence, eyes })
    }
    return {
      review: {
        focus: detailScore(gray, w, h),
        black: black / gray.length,
        white: white / gray.length,
        faces,
        width: w,
        height: h
      }
    }
  } finally {
    detector?.delete()
    mat.delete()
    bgr.delete()
    output.delete()
  }
}
