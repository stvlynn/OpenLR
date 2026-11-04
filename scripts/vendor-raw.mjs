import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises'
import path from 'node:path'

// Preserve upstream modules and notices; adapt only bare imports for static hosting.
const destination = 'web/vendor/libraw'
const source = 'node_modules/@colorhythm/libraw-wasm'
await mkdir(destination, { recursive: true })
for (const name of ['index.js', 'libraw-types.js', 'libraw.mjs', 'libraw.wasm']) {
  const from = path.join(source, 'dist', name),
    to = path.join(destination, name)
  if (name.endsWith('.js')) {
    const text = await readFile(from, 'utf8')
    await writeFile(
      to,
      text
        .replaceAll('"typed-cstruct"', '"./typed-cstruct/index.js"')
        .replaceAll("'typed-cstruct'", "'./typed-cstruct/index.js'")
    )
  } else await copyFile(from, to)
}
async function copyModules(from, to) {
  await mkdir(to, { recursive: true })
  for (const item of await readdir(from, { withFileTypes: true })) {
    if (item.isDirectory()) await copyModules(path.join(from, item.name), path.join(to, item.name))
    else if (item.name.endsWith('.js')) await copyFile(path.join(from, item.name), path.join(to, item.name))
  }
}
await copyModules('node_modules/typed-cstruct/dist', path.join(destination, 'typed-cstruct'))
await copyFile('node_modules/typed-cstruct/LICENSE', path.join(destination, 'typed-cstruct', 'LICENSE'))
await copyFile(path.join(source, 'LICENSE'), path.join(destination, 'LICENSE.MIT'))
for (const name of ['COPYRIGHT', 'LICENSE.LGPL', 'LICENSE.CDDL'])
  await copyFile(path.join(source, 'LibRaw', name), path.join(destination, name))
console.log('Vendored @colorhythm/libraw-wasm 1.1.1 and typed-cstruct 0.10.2')
