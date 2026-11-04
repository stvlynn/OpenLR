import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const destination = 'web/vendor/codecs/notices'
await mkdir(destination, { recursive: true })
const records = []
async function retain(name, url, base64 = false) {
  const response = await fetch(url, { headers: { 'User-Agent': 'OpenLR-codec-provenance' } })
  if (!response.ok) throw Error(response.status + ' ' + url)
  const bytes = base64
    ? Buffer.from(await response.text(), 'base64')
    : Buffer.from(await response.arrayBuffer())
  await writeFile(destination + '/' + name, bytes)
  records.push({ name, url, sha256: createHash('sha256').update(bytes).digest('hex') })
}
const libjxl = '9f544641ec83f6abd9da598bdd08178ee8a003e0'
const response = await fetch(
  'https://api.github.com/repos/libjxl/libjxl/git/trees/' + libjxl + '?recursive=1',
  { headers: { 'User-Agent': 'OpenLR-codec-provenance' } }
)
if (!response.ok) throw Error('Cannot inspect fixed libjxl dependency identities')
const { tree } = await response.json(),
  revision = (name) => tree.find((item) => item.path === 'third_party/' + name)?.sha
const sources = [
  ['LICENSE.libavif', 'https://raw.githubusercontent.com/AOMediaCodec/libavif/v1.0.1/LICENSE'],
  ['LICENSE.libaom', 'https://aomedia.googlesource.com/aom/+/refs/tags/v3.7.0/LICENSE?format=TEXT', true],
  ['PATENTS.libaom', 'https://aomedia.googlesource.com/aom/+/refs/tags/v3.7.0/PATENTS?format=TEXT', true],
  [
    'COPYING.libwebp',
    'https://chromium.googlesource.com/webm/libwebp/+/e2c85878f6a33f29948b43d3492d9cdaf801aa54/COPYING?format=TEXT',
    true
  ],
  [
    'PATENTS.libwebp',
    'https://chromium.googlesource.com/webm/libwebp/+/e2c85878f6a33f29948b43d3492d9cdaf801aa54/PATENTS?format=TEXT',
    true
  ],
  ['LICENSE.libjxl', 'https://raw.githubusercontent.com/libjxl/libjxl/' + libjxl + '/LICENSE'],
  ['PATENTS.libjxl', 'https://raw.githubusercontent.com/libjxl/libjxl/' + libjxl + '/PATENTS'],
  ['AUTHORS.libjxl', 'https://raw.githubusercontent.com/libjxl/libjxl/' + libjxl + '/AUTHORS'],
  ['LICENSE.brotli', 'https://raw.githubusercontent.com/google/brotli/' + revision('brotli') + '/LICENSE'],
  ['LICENSE.highway', 'https://raw.githubusercontent.com/google/highway/' + revision('highway') + '/LICENSE'],
  [
    'LICENSE.skcms',
    'https://skia.googlesource.com/skcms/+/' + revision('skcms') + '/LICENSE?format=TEXT',
    true
  ]
]
await Promise.all(
  sources.map(async (args) => {
    await retain(...args)
  })
)
await copyFile('web/vendor/libraw/LICENSE.EMSCRIPTEN', destination + '/LICENSE.EMSCRIPTEN')
await writeFile(
  destination + '/sources.json',
  JSON.stringify(
    {
      libjxl,
      dependencies: Object.fromEntries(['brotli', 'highway', 'skcms'].map((name) => [name, revision(name)])),
      records: records.sort((a, b) => a.name.localeCompare(b.name))
    },
    null,
    2
  ) + '\n'
)
console.log('Retained ' + records.length + ' fixed codec component notices and Emscripten license')
