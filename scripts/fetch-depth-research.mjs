import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const id = 'onnx-community/depth-anything-v2-small',
  revision = '4472b7362082ad9968fee890ca0f1e5aca36b93d',
  api = await (
    await fetch('https://huggingface.co/api/models/' + id + '/revision/' + revision + '?blobs=true')
  ).json()
const metadata = {
  id,
  revision,
  license: api.cardData?.license,
  files: api.siblings.filter((file) => /onnx|README|LICENSE|preprocessor/.test(file.rfilename))
}
await mkdir('research/ai', { recursive: true })
await writeFile('research/ai/depth-candidates.json', JSON.stringify(metadata, null, 2) + '\n')
await mkdir('.tools/ai-models', { recursive: true })
const name = process.argv.includes('--fp32') ? 'model.onnx' : 'model_quantized.onnx',
  url = `https://huggingface.co/${id}/resolve/${revision}/onnx/${name}`,
  path = '.tools/ai-models/depth-' + name
let bytes
try {
  bytes = await readFile(path)
} catch {
  const response = await fetch(url)
  if (!response.ok) throw Error('Model HTTP ' + response.status)
  bytes = Buffer.from(await response.arrayBuffer())
  await writeFile(path, bytes)
}
for (const name of ['README.md', 'preprocessor_config.json']) {
  const response = await fetch(`https://huggingface.co/${id}/resolve/${revision}/${name}`)
  if (response.ok) await writeFile('research/ai/depth-' + name, await response.text())
}
await writeFile(
  'research/ai/depth-weight' + (name === 'model.onnx' ? '-fp32' : '') + '.json',
  JSON.stringify(
    { url, revision, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    null,
    2
  ) + '\n'
)
console.log(JSON.stringify({ revision, bytes: bytes.length, url }))
