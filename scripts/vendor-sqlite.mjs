import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import initSqlJs from 'sql.js'
const target = 'web/vendor/sqlite',
  source = 'node_modules/sql.js'
await mkdir(target, { recursive: true })
const module = await readFile(source + '/dist/sql-wasm-browser.js', 'utf8')
await writeFile(
  target + '/sql.js',
  '// OpenLR adaptation: declare the UMD shell variable in strict ES module scope.\nlet module;\n' +
    module +
    '\n// OpenLR adaptation: expose the upstream UMD factory as an ES module.\nexport default initSqlJs;\n'
)
for (const [from, to] of [
  ['dist/sql-wasm-browser.wasm', 'sql-wasm.wasm'],
  ['LICENSE', 'LICENSE'],
  ['AUTHORS', 'AUTHORS']
])
  await copyFile(source + '/' + from, target + '/' + to)
await copyFile('web/vendor/opencv/LICENSE.EMSCRIPTEN', target + '/LICENSE.EMSCRIPTEN')
const files = {}
for (const name of ['sql.js', 'sql-wasm.wasm', 'LICENSE', 'AUTHORS', 'LICENSE.EMSCRIPTEN']) {
  const bytes = await readFile(target + '/' + name)
  files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
const SQL = await initSqlJs(),
  database = new SQL.Database(),
  [[sqliteVersion, sqliteSourceId]] = database.exec('SELECT sqlite_version(), sqlite_source_id()')[0].values
database.close()
await writeFile(
  target + '/manifest.json',
  JSON.stringify(
    {
      package: 'sql.js',
      version: '1.15.2',
      source: 'https://github.com/sql-js/sql.js/tree/v1.15.2',
      license: 'MIT',
      sqlite: { version: sqliteVersion, sourceId: sqliteSourceId },
      modification:
        'Added module-scope UMD variable and ES module default export around unchanged factory body; WASM unchanged',
      files
    },
    null,
    2
  ) + '\n'
)
console.log(JSON.stringify({ version: '1.15.2', files: Object.keys(files) }))
