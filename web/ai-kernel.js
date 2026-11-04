import { ort, modelSession, fetchModel } from './ai-runtime.js'
import { AI_TARGETS, modelFor } from './ai-models.js'
export { AI_TARGETS, modelFor } from './ai-models.js'
async function load(model) {
  return modelSession(model.file, () => fetchModel(new URL('./models/' + model.file, import.meta.url)))
}
// This kernel is shared by the worker and the native-host compatibility path.
// normalization is exposed only to reproducible research scripts, not the product UI.
export async function inferSemantic({ pixels, target = 'subject', normalization = 'standard', modelUrl }) {
  if (!AI_TARGETS.includes(target)) throw Error('No licensed model is installed for target ' + target)
  if (target === 'sky') return (await import('./sky-kernel.js')).inferSky({ pixels, normalization, modelUrl })
  const model = modelFor(target),
    start = performance.now(),
    session = await load(model),
    loaded = performance.now()
  const { width, height, data } = pixels,
    area = width * height
  if (width !== model.width || height !== model.height)
    throw Error('Unexpected segmentation tensor dimensions')
  const input = new Float32Array(area * 3),
    subject = target !== 'person'
  let maximum = 255
  if (subject) {
    maximum = 0
    for (let i = 0; i < data.length; i++) if (i % 4 !== 3) maximum = Math.max(maximum, data[i])
    maximum = Math.max(1, maximum)
  }
  const mean = subject ? [0.485, 0.456, 0.406] : [0.5, 0.5, 0.5],
    std = subject ? [0.229, 0.224, 0.225] : [0.5, 0.5, 0.5]
  for (let i = 0; i < area; i++)
    for (let c = 0; c < 3; c++) {
      const value = data[i * 4 + c] / maximum
      input[c * area + i] = normalization === 'none' ? value : (value - mean[c]) / std[c]
    }
  const before = performance.now(),
    output = await session.run({
      [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, height, width])
    }),
    inferred = performance.now()
  const tensor = output[session.outputNames[0]],
    dims = tensor.dims,
    w = dims.at(-1),
    h = dims.at(-2),
    count = w * h,
    values = tensor.data
  const probabilities = new Float32Array(count)
  if (subject) {
    let min = Infinity,
      max = -Infinity
    for (let i = 0; i < count; i++) {
      min = Math.min(min, values[i])
      max = Math.max(max, values[i])
    }
    for (let i = 0; i < count; i++)
      probabilities[i] = max > min ? (values[i] - min) / (max - min) : Math.max(0, Math.min(1, values[i]))
  } else {
    if (dims.length !== 4 || dims[1] !== 2) throw Error('Unexpected person-model output layout')
    for (let i = 0; i < count; i++) {
      const background = values[i],
        person = values[count + i]
      // PPHumanSeg exports class probabilities. Retain them rather than hard argmax.
      probabilities[i] = Math.max(0, Math.min(1, person / (background + person || 1)))
    }
  }
  if (target === 'background') for (let i = 0; i < count; i++) probabilities[i] = 1 - probabilities[i]
  const mask = Uint8Array.from(probabilities, (value) => Math.round(value * 255))
  return {
    width: w,
    height: h,
    mask,
    provenance: {
      target,
      model: model.file,
      sha256: model.sha256,
      revision: model.revision,
      license: model.license,
      runtime: 'onnxruntime-web 1.31.1 / wasm CPU',
      normalization
    },
    metrics: {
      loadMs: loaded - start,
      preprocessMs: before - loaded,
      inferenceMs: inferred - before,
      totalMs: performance.now() - start
    },
    output: {
      dims: [...dims],
      minimum: Math.min(...values.slice(0, Math.min(2048, values.length))),
      maximum: Math.max(...values.slice(0, Math.min(2048, values.length)))
    }
  }
}
