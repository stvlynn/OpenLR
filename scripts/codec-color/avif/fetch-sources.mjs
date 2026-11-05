// Downloads only fixed upstream source revisions. No SDK installation or build.
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const workDir = process.env.OPENLR_AVIF_BUILD_DIR || resolve(workspace, '.tools/codec-color/avif')
const sourceDir = join(workDir, 'sources')
const manifest = JSON.parse(await readFile(new URL('./sources.json', import.meta.url), 'utf8'))
await mkdir(sourceDir, { recursive: true })
for (const source of manifest.sources) {
  const target = join(sourceDir, source.name)
  const ready = await access(join(target, 'CMakeLists.txt')).then(
    () => true,
    () => false
  )
  if (ready) continue
  const archive = join(sourceDir, `${source.name}.tar.gz`)
  console.log(`Fetching ${source.name} ${source.revision}`)
  const response = await fetch(source.url)
  if (!response.ok) throw new Error(`${source.name}: HTTP ${response.status}`)
  await writeFile(archive, new Uint8Array(await response.arrayBuffer()))
  await mkdir(target, { recursive: true })
  const extraction = spawnSync(
    'tar',
    ['-xzf', archive, `--strip-components=${source.stripComponents}`, '-C', target],
    { stdio: 'inherit' }
  )
  if (extraction.error) throw extraction.error
  if (extraction.status !== 0) throw new Error(`${source.name}: tar exited ${extraction.status}`)
  await access(join(target, 'CMakeLists.txt'))
}
