import {build} from 'esbuild'
import {chmod} from 'node:fs/promises'

const output='resources/cli/openlr.mjs'
await build({
  entryPoints:['cli/openlr.mjs'],
  outfile:output,
  platform:'node',
  target:'node24',
  format:'esm',
  bundle:true,
  legalComments:'eof'
})
await chmod(output,0o755)
