import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const revision = 'ea24b2d4e0bfae31f0a1299ba3fb892a2df064de'
await mkdir('.tools/ai-models', { recursive: true })
const fp32 = process.argv.includes('--fp32'),
  filename = fp32 ? 'detr-fp32.onnx' : 'detr-quantized.onnx'
const url =
  'https://huggingface.co/Xenova/detr-resnet-50-panoptic/resolve/' +
  revision +
  '/onnx/' +
  (fp32 ? 'model.onnx' : 'model_quantized.onnx')
let bytes
try {
  bytes = await readFile('.tools/ai-models/' + filename)
} catch {
  const response = await fetch(url)
  if (!response.ok) throw Error('Download failed: ' + response.status)
  bytes = Buffer.from(await response.arrayBuffer())
  await writeFile('.tools/ai-models/' + filename, bytes)
}
await writeFile(
  'research/ai/sky-weight' + (fp32 ? '-fp32' : '') + '.json',
  JSON.stringify(
    {
      url,
      revision,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      localPath: '.tools/ai-models/' + filename
    },
    null,
    2
  ) + '\n'
)
const response = await fetch(
  'https://raw.githubusercontent.com/scikit-image/scikit-image/v0.25.2/skimage/data/rocket.jpg'
)
if (!response.ok) throw Error('Fixture failed: ' + response.status)
await writeFile('tests/fixtures/ai/rocket.jpg', Buffer.from(await response.arrayBuffer()))
console.log('One canonical optional DETR weight downloaded: ' + bytes.length + ' bytes')
