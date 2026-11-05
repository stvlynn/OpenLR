import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { patchUtif } from './patch-utif.mjs'

const root = 'web/vendor/codecs'
await mkdir(root, { recursive: true })
// Keep rebuilt color-capable bindings intact. Only the unchanged JPEG XL
// decoder and small upstream metadata/helpers still come from npm.
for (const [codec, files] of [
  ['avif', ['LICENSE', 'meta.js']],
  ['jxl', ['LICENSE', 'decode.js', 'utils.js', 'codec/dec/jxl_dec.js', 'codec/dec/jxl_dec.wasm']]
]) {
  for (const name of files) {
    const destination = path.join(root, codec, name)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(path.join('node_modules/@jsquash', codec, name), destination)
  }
}
await copyFile(
  'node_modules/wasm-feature-detect/dist/esm/index.js',
  path.join(root, 'wasm-feature-detect.js')
)
await copyFile('node_modules/wasm-feature-detect/LICENSE', path.join(root, 'LICENSE.wasm-feature-detect'))
const pako = await readFile('node_modules/pako/dist/pako.js', 'utf8')
await writeFile(
  path.join(root, 'pako.js'),
  '// ESM adapter around unmodified pako UMD source.\nconst module={exports:{}}; const exports=module.exports;\n' +
    pako +
    '\nexport default module.exports;\n'
)
const utif = patchUtif((await readFile('node_modules/utif/UTIF.js', 'utf8')).replaceAll('\r\n', '\n'))
await writeFile(
  path.join(root, 'utif.js'),
  "// ESM adapter around pinned UTIF CommonJS source with documented OpenLR corrections.\nimport pako from './pako.js';\nconst module={exports:{}};const require=name=>{if(name==='pako')return pako;throw Error('Unknown dependency: '+name)};\n" +
    utif +
    '\nexport default module.exports;\n'
)
await copyFile('node_modules/utif/LICENSE', path.join(root, 'LICENSE.UTIF'))
await copyFile('node_modules/pako/LICENSE', path.join(root, 'LICENSE.pako'))
await copyFile('node_modules/pako/lib/zlib/README', path.join(root, 'NOTICE.pako-zlib'))
const hashes = {}
async function inventory(folder) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, item.name)
    if (item.isDirectory()) await inventory(file)
    else if (/\.(js|mjs|wasm)$/.test(item.name)) {
      const bytes = await readFile(file)
      hashes[path.relative(root, file).replaceAll('\\', '/')] = {
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
    }
  }
}
await inventory(root)
await writeFile(
  path.join(root, 'manifest.json'),
  JSON.stringify(
    {
      packages: {
        utif: '3.1.0',
        pako: '1.0.11',
        '@jsquash/avif': '2.1.1',
        '@jsquash/jxl': '1.3.0',
        'wasm-feature-detect': '1.9.0'
      },
      rebuiltBindings: {
        toolchain: 'Emscripten 3.1.64',
        avif: 'scripts/codec-color/avif/sources.json',
        jxlEncoder: 'scripts/codec-color/jxl/sources.json',
        recipe: 'scripts/codec-color/README.md'
      },
      files: hashes
    },
    null,
    2
  ) + '\n'
)
console.log('Vendored npm codec dependencies; retained rebuilt color bindings and notices')
