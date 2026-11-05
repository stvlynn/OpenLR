import { access, copyFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url)),
  target = path.join(root, 'web/vendor/codecs'),
  work = path.join(root, '.tools/codec-color'),
  files = []
function add(source, destination, stem) {
  for (const extension of ['js', 'wasm'])
    files.push([
      path.join(work, source, `${stem}.${extension}`),
      path.join(target, destination, `${stem}.${extension}`)
    ])
}
add('avif/output/enc', 'avif/codec/enc', 'avif_enc')
add('avif/output/enc', 'avif/codec/enc', 'avif_enc_mt')
add('avif/output/dec', 'avif/codec/dec', 'avif_dec')
add('jxl/build', 'jxl/codec/enc', 'jxl_color_enc')
add('jxl/build-mt', 'jxl/codec/enc', 'jxl_color_enc_mt')
add('jxl/build-mt-simd', 'jxl/codec/enc', 'jxl_color_enc_mt_simd')
// Require the complete build before replacing any shipped runtime artifact.
await Promise.all(files.map(([source]) => access(source)))
for (const [source, destination] of files) {
  await mkdir(path.dirname(destination), { recursive: true })
  await copyFile(source, destination)
}
const obsolete = [
  'avif/codec/enc/avif_enc_mt.worker.mjs',
  'jxl/codec/enc/jxl_color_enc_mt.worker.mjs',
  'jxl/codec/enc/jxl_color_enc_mt_simd.worker.mjs',
  'avif/codec/pre.js',
  'jxl/codec/pre.js',
  'avif/encode.js',
  'avif/decode.js',
  'avif/index.js',
  'avif/utils.js',
  'jxl/encode.js',
  'jxl/index.js',
  'jxl/meta.js'
]
for (const name of await readdir(path.join(target, 'jxl/codec/enc')))
  if (/^jxl_enc(?:_mt(?:_simd)?)?\.(?:js|wasm|worker\.js)$/.test(name)) obsolete.push('jxl/codec/enc/' + name)
for (const name of obsolete)
  await unlink(path.join(target, name)).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
// Refresh existing provenance inventory without overwriting the rebuilt bindings.
await import('../vendor-codecs.mjs')
console.log('Installed rebuilt AVIF and JPEG XL color bindings')
