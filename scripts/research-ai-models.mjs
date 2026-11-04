import { writeFile, mkdir } from 'node:fs/promises'
const ids = [
  'JianyuanWang/skyseg',
  'voyagerfromeast/skyseg',
  'facebook/detr-resnet-50-panoptic',
  'Xenova/detr-resnet-50-panoptic'
]
const results = []
for (const id of ids) {
  const response = await fetch('https://huggingface.co/api/models/' + id + '?blobs=true')
  if (!response.ok) {
    results.push({ id, status: response.status })
    continue
  }
  const metadata = await response.json(),
    revision = metadata.sha
  const files = metadata.siblings
    .map(({ rfilename, size, lfs }) => ({ path: rfilename, bytes: size, sha256: lfs?.sha256 }))
    .filter((file) => /onnx|config.json|LICENSE|README/.test(file.path))
  const configResponse = await fetch('https://huggingface.co/' + id + '/resolve/' + revision + '/config.json')
  let labels
  if (configResponse.ok) {
    const config = await configResponse.json()
    labels = Object.entries(config.id2label ?? {}).filter(([key, value]) =>
      /sky|person|background/i.test(value)
    )
  }
  results.push({ id, revision, license: metadata.cardData?.license, files, labels })
}
await mkdir('research/ai', { recursive: true })
await writeFile('research/ai/candidates.json', JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify(results, null, 2))
