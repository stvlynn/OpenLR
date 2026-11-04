import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const directory = 'web/models'
await mkdir(directory, { recursive: true })
await mkdir('tests/fixtures/ai', { recursive: true })
async function get(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'OpenLR-model-provenance' } })
  if (!response.ok) throw Error(response.status + ' ' + url)
  return Buffer.from(await response.arrayBuffer())
}
const commit = async (repo) =>
  JSON.parse((await get('https://api.github.com/repos/' + repo + '/commits/HEAD')).toString()).sha
let prior
try {
  prior = JSON.parse(await readFile(directory + '/manifest.json', 'utf8'))
} catch {}
const zoo = prior?.sources.zoo ?? (await commit('opencv/opencv_zoo')),
  u2net = prior?.sources.u2net ?? (await commit('xuebinqin/U-2-Net'))
const sources = { zoo, u2net }
const records = {}
async function retain(name, url) {
  const bytes = await get(url),
    sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(directory + '/' + name, bytes)
  records[name] = { url, bytes: bytes.length, sha256 }
}
await Promise.all([
  retain('u2netp.onnx', 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx'),
  retain(
    'pphumanseg.onnx',
    'https://media.githubusercontent.com/media/opencv/opencv_zoo/' +
      zoo +
      '/models/human_segmentation_pphumanseg/human_segmentation_pphumanseg_2023mar.onnx'
  ),
  retain('LICENSE.U2NET', 'https://raw.githubusercontent.com/xuebinqin/U-2-Net/' + u2net + '/LICENSE'),
  retain(
    'LICENSE.PPHumanSeg',
    'https://raw.githubusercontent.com/opencv/opencv_zoo/' +
      zoo +
      '/models/human_segmentation_pphumanseg/LICENSE'
  ),
  retain(
    'SOURCE.PPHumanSeg.py',
    'https://raw.githubusercontent.com/opencv/opencv_zoo/' +
      zoo +
      '/models/human_segmentation_pphumanseg/pphumanseg.py'
  )
])
await writeFile(directory + '/manifest.json', JSON.stringify({ sources, files: records }, null, 2) + '\n')
const astronaut = await get(
  'https://raw.githubusercontent.com/scikit-image/scikit-image/v0.25.2/skimage/data/astronaut.png'
)
await writeFile('tests/fixtures/ai/astronaut.png', astronaut)
console.log(
  JSON.stringify({
    sources,
    models: Object.fromEntries(Object.entries(records).filter(([key]) => key.endsWith('.onnx'))),
    astronautBytes: astronaut.length
  })
)
