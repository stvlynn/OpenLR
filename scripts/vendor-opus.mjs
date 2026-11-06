import { mkdir, readFile, writeFile } from 'node:fs/promises'

const source = new URL('../node_modules/libopus-wasm/', import.meta.url)
const destination = new URL('../web/vendor/opus/', import.meta.url)
const version = '0.4.1'
const emscripten = 'https://raw.githubusercontent.com/emscripten-core/emscripten/6.0.10/'
const notices = [
  ['COPYING.libopus', 'https://raw.githubusercontent.com/xiph/opus/v1.6.1/COPYING'],
  ['LICENSE.EMSCRIPTEN', emscripten + 'LICENSE'],
  ['COPYRIGHT.musl', emscripten + 'system/lib/libc/musl/COPYRIGHT'],
  ['LICENSE.compiler-rt', emscripten + 'system/lib/compiler-rt/LICENSE.TXT']
]

const installed = JSON.parse(await readFile(new URL('package.json', source), 'utf8'))
if (installed.name !== 'libopus-wasm' || installed.version !== version)
  throw Error(`Install libopus-wasm ${version} first`)

const files = await Promise.all([
  ...['index.js', 'generated/libopus.generated.mjs'].map(async (name) => [
    name,
    await readFile(new URL(`dist/${name}`, source))
  ]),
  ...['LICENSE', 'THIRD_PARTY_NOTICES.md'].map(async (name) => [name, await readFile(new URL(name, source))]),
  ...notices.map(async ([name, url]) => {
    const bytes = await readFile(new URL(name, destination)).catch(async (error) => {
      if (error.code !== 'ENOENT') throw error
      const response = await fetch(url)
      if (!response.ok) throw Error(`Could not retrieve ${name} (${response.status})`)
      return Buffer.from(await response.arrayBuffer())
    })
    return [name, bytes]
  })
])

await mkdir(new URL('generated/', destination), { recursive: true })
await Promise.all(files.map(([name, bytes]) => writeFile(new URL(name, destination), bytes)))
console.log(`Vendored the exact libopus-wasm ${version} runtime and upstream notices`)
