import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const directory = 'web/vendor/onnx'
await mkdir(directory, { recursive: true })
const files = {}
for (const name of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  const from = 'node_modules/onnxruntime-web/dist/' + name,
    bytes = await readFile(from)
  await copyFile(from, directory + '/' + name)
  files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
await writeFile(
  directory + '/manifest.json',
  JSON.stringify({ package: 'onnxruntime-web', version: '1.31.1', files }, null, 2) + '\n'
)
console.log('Vendored only the ONNX Runtime WASM CPU entry and its matching module/binary')
