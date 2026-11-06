import { ort, modelSession, fetchModel, cachedModel } from './ai-runtime.js'
export const DEPTH_MODEL = {
  file: 'depth-anything-v2-small-quantized.onnx',
  revision: '4472b7362082ad9968fee890ca0f1e5aca36b93d',
  license: 'Apache-2.0',
  bytes: 27258801,
  sha256: 'fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d',
  url: 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_quantized.onnx'
}
export async function inferDepth({ pixels, normalization = 'standard', modelUrl, onProgress }) {
  const start = performance.now(),
    session = await modelSession(modelUrl || DEPTH_MODEL.url, () =>
      modelUrl ? fetchModel(modelUrl, onProgress) : cachedModel(DEPTH_MODEL, 'depth', onProgress)
    ),
    loaded = performance.now()
  const { width, height, data } = pixels,
    area = width * height,
    input = new Float32Array(area * 3),
    mean = [0.485, 0.456, 0.406],
    std = [0.229, 0.224, 0.225]
  for (let i = 0; i < area; i++)
    for (let c = 0; c < 3; c++) {
      const value = data[i * 4 + c] / 255
      input[c * area + i] = normalization === 'none' ? value : (value - mean[c]) / std[c]
    }
  const before = performance.now(),
    outputs = await session.run({
      [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, height, width])
    }),
    inferred = performance.now(),
    tensor = Object.values(outputs)[0]
  if (!tensor || tensor.dims.length < 3) throw Error('Unexpected relative depth model output')
  let min = Infinity,
    max = -Infinity
  for (const value of tensor.data) {
    if (!Number.isFinite(value)) throw Error('Depth model produced a non-finite sample')
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  const range = max - min,
    mask = Uint8Array.from(tensor.data, (value) => Math.round((range ? (value - min) / range : 0) * 255))
  return {
    width: tensor.dims.at(-1),
    height: tensor.dims.at(-2),
    mask,
    provenance: {
      model: DEPTH_MODEL.file,
      revision: DEPTH_MODEL.revision,
      license: DEPTH_MODEL.license,
      transfer: 'relative inverse depth: 0 far, 1 near; not metres',
      normalization,
      runtime: 'onnxruntime-web 1.31.1 / wasm CPU'
    },
    metrics: {
      loadMs: loaded - start,
      preprocessMs: before - loaded,
      inferenceMs: inferred - before,
      totalMs: performance.now() - start
    },
    output: { dims: tensor.dims, min, max }
  }
}
