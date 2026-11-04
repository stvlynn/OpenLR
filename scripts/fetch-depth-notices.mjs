import { writeFile } from 'node:fs/promises'
const repo = 'DepthAnything/Depth-Anything-V2',
  revision = (
    await (
      await fetch('https://api.github.com/repos/' + repo + '/commits/main', {
        headers: { 'User-Agent': 'OpenLR-source-research' }
      })
    ).json()
  ).sha
if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Cannot resolve upstream depth source revision')
const sources = []
for (const [file, target] of [
  ['LICENSE', 'web/models/LICENSE.DepthAnythingV2'],
  ['README.md', 'research/ai/README.DepthAnythingV2.md']
]) {
  const url = `https://raw.githubusercontent.com/${repo}/${revision}/${file}`,
    response = await fetch(url)
  if (!response.ok) throw Error('License HTTP ' + response.status)
  await writeFile(target, await response.text())
  sources.push({ url, target })
}
const base = 'https://huggingface.co/depth-anything/Depth-Anything-V2-Small',
  metadata = await (
    await fetch('https://huggingface.co/api/models/depth-anything/Depth-Anything-V2-Small')
  ).json(),
  url = base + '/resolve/' + metadata.sha + '/README.md',
  response = await fetch(url)
if (!response.ok) throw Error('Model card HTTP ' + response.status)
await writeFile('web/models/README.DepthAnythingV2Small.md', await response.text())
sources.push({ url, target: 'web/models/README.DepthAnythingV2Small.md' })
await writeFile(
  'research/ai/depth-sources.json',
  JSON.stringify({ upstreamRevision: revision, modelRevision: metadata.sha, sources }, null, 2) + '\n'
)
console.log(JSON.stringify({ revision, license: metadata.cardData?.license }))
