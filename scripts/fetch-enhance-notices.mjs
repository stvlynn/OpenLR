import { writeFile } from 'node:fs/promises'
const headers = { 'User-Agent': 'OpenLR-enhancement-source-review' },
  repo = 'onnx/models',
  revision = (
    await (await fetch('https://api.github.com/repos/' + repo + '/commits/main', { headers })).json()
  ).sha
if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Cannot resolve model-zoo source revision')
const source = {
    url: `https://raw.githubusercontent.com/${repo}/${revision}/LICENSE`,
    target: 'web/models/LICENSE.ESPCN'
  },
  response = await fetch(source.url)
if (!response.ok) throw Error('License HTTP ' + response.status)
await writeFile(source.target, await response.text())
await writeFile(
  'research/enhance/license-sources.json',
  JSON.stringify(
    {
      onnxModelZooRevision: revision,
      sources: [
        source,
        {
          url: 'https://raw.githubusercontent.com/pmndrs/denoiser-weights/24f30f6b04fc6e8c3b1b1993227d230d3a9344f1/LICENSE',
          target: 'web/models/LICENSE.OIDN'
        }
      ]
    },
    null,
    2
  ) + '\n'
)
console.log(revision)
