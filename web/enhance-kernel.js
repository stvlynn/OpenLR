import { ort, modelSession, cachedModel, fetchModel } from './ai-runtime.js'
import { ENHANCE_MODELS } from './enhance-models.js'
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const linear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
const srgb = (value) => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055)
function reflect(index, length) {
  if (length === 1) return 0
  const period = 2 * (length - 1),
    n = ((index % period) + period) % period
  return n < length ? n : period - n
}
function sample(data, width, height, x, y) {
  x = clamp(x, 0, width - 1)
  y = clamp(y, 0, height - 1)
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    fx = x - x0,
    fy = y - y0,
    result = [0, 0, 0, 0]
  for (const [px, py, w] of [
    [x0, y0, (1 - fx) * (1 - fy)],
    [Math.min(width - 1, x0 + 1), y0, fx * (1 - fy)],
    [x0, Math.min(height - 1, y0 + 1), (1 - fx) * fy],
    [Math.min(width - 1, x0 + 1), Math.min(height - 1, y0 + 1), fx * fy]
  ])
    for (let c = 0; c < 4; c++) result[c] += data[(py * width + px) * 4 + c] * w
  return result
}
export async function processEnhance({
  pixels,
  mode = 'denoise',
  strength = 1,
  tileSize = 256,
  modelUrl,
  transfer = 'linear',
  onProgress
}) {
  const model = ENHANCE_MODELS[mode]
  if (
    !model ||
    !Number.isFinite(strength) ||
    strength < 0 ||
    strength > 1 ||
    !Number.isInteger(tileSize) ||
    tileSize < 1
  )
    throw Error('Invalid neural enhancement options')
  const start = performance.now(),
    session = await modelSession(modelUrl || model.url, () =>
      modelUrl ? fetchModel(modelUrl) : cachedModel(model, 'enhance-' + model.id)
    ),
    loaded = performance.now(),
    { width, height, data } = pixels,
    scale = model.scale,
    outWidth = width * scale,
    outHeight = height * scale,
    result = new Uint8ClampedArray(outWidth * outHeight * 4)
  const shape = session.inputMetadata[0].shape ?? session.inputMetadata[0].dimensions,
    fixedWidth = Number.isInteger(shape?.[3]) ? shape[3] : 0,
    fixedHeight = Number.isInteger(shape?.[2]) ? shape[2] : 0,
    step = Math.min(
      tileSize,
      fixedWidth ? fixedWidth - 2 * model.halo : Infinity,
      fixedHeight ? fixedHeight - 2 * model.halo : Infinity
    )
  if (step < 1) throw Error('Enhancement model has an incompatible input shape')
  let inferenceMs = 0,
    tiles = 0
  for (let top = 0; top < height; top += step)
    for (let left = 0; left < width; left += step) {
      const coreWidth = Math.min(step, width - left),
        coreHeight = Math.min(step, height - top),
        w = fixedWidth || Math.ceil((coreWidth + 2 * model.halo) / model.alignment) * model.alignment,
        h = fixedHeight || Math.ceil((coreHeight + 2 * model.halo) / model.alignment) * model.alignment,
        area = w * h,
        input = new Float32Array(area * model.channels)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i =
              (reflect(top + y - model.halo, height) * width + reflect(left + x - model.halo, width)) * 4,
            j = y * w + x
          if (model.channels === 1)
            input[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
          else
            for (let c = 0; c < 3; c++)
              input[c * area + j] = transfer === 'none' ? data[i + c] / 255 : linear(data[i + c] / 255)
        }
      const before = performance.now(),
        outputs = await session.run({
          [session.inputNames[0]]: new ort.Tensor('float32', input, [1, model.channels, h, w])
        }),
        output = Object.values(outputs)[0]
      inferenceMs += performance.now() - before
      if (!output || output.dims.at(-1) !== w * scale || output.dims.at(-2) !== h * scale)
        throw Error('Unexpected enhancement model output shape')
      const outputArea = w * h * scale * scale
      for (let y = 0; y < coreHeight * scale; y++)
        for (let x = 0; x < coreWidth * scale; x++) {
          const px = left * scale + x,
            py = top * scale + y,
            i = (py * outWidth + px) * 4,
            j = (y + model.halo * scale) * w * scale + x + model.halo * scale,
            base = sample(data, width, height, (px + 0.5) / scale - 0.5, (py + 0.5) / scale - 0.5)
          if (model.channels === 1) {
            const predicted = output.data[j] * 255,
              originalY = base[0] * 0.299 + base[1] * 0.587 + base[2] * 0.114,
              delta = (predicted - originalY) * strength
            if (!Number.isFinite(delta)) throw Error('Super-resolution produced a non-finite pixel')
            for (let c = 0; c < 3; c++) result[i + c] = base[c] + delta
          } else
            for (let c = 0; c < 3; c++) {
              const value = output.data[c * outputArea + j]
              if (!Number.isFinite(value)) throw Error('Denoiser produced a non-finite pixel')
              const encoded = (transfer === 'none' ? value : srgb(clamp(value))) * 255
              result[i + c] = base[c] * (1 - strength) + encoded * strength
            }
          result[i + 3] = base[3]
        }
      tiles++
      onProgress?.({ tiles, total: Math.ceil(width / step) * Math.ceil(height / step) })
    }
  return {
    width: outWidth,
    height: outHeight,
    data: result,
    provenance: {
      mode,
      model: model.id,
      revision: model.revision,
      license: model.license,
      sourceTransfer: '8-bit decoded sRGB raster; not sensor RAW denoising',
      strength,
      scale,
      transfer,
      runtime: 'onnxruntime-web 1.31.1 / wasm CPU',
      tileSize: step,
      halo: model.halo
    },
    metrics: { loadMs: loaded - start, inferenceMs, totalMs: performance.now() - start, tiles }
  }
}
