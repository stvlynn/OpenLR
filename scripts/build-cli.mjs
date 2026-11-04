import { build } from 'esbuild'
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'

const output = 'resources/cli/openlr.mjs'
await build({
  entryPoints: ['cli/openlr.mjs'],
  outfile: output,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  bundle: true,
  legalComments: 'eof'
})
await chmod(output, 0o755)
await mkdir('resources/licenses', { recursive: true })
await copyFile('LICENSE', 'resources/licenses/OpenLR-AGPL-3.0.txt')
await copyFile('THIRD_PARTY_NOTICES.md', 'resources/THIRD_PARTY_NOTICES.md')
await writeFile(
  'resources/SOURCE.md',
  '# OpenLR source and licenses\n\nOpenLR source: https://github.com/stvlynn/OpenLR\n\nThe complete project license is in licenses/OpenLR-AGPL-3.0.txt. Component provenance and retained notice locations are in THIRD_PARTY_NOTICES.md. Vendored runtime notices and LibRaw corresponding-source archives are embedded from web/vendor/ and retained in the source repository.\n'
)
