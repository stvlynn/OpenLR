import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { makePng } from '../tests/fixtures/png.mjs'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const [executable, cli] = process.argv.slice(2)
if (!executable || !cli) throw Error('Pass the installed desktop executable and CLI paths')
const installedCli = path.resolve(cli)
const run = promisify(execFile)
const rgb = [64, 96, 128]
const source = Buffer.from(
  makePng({
    width: 32,
    height: 24,
    bits: 8,
    data: Array(32 * 24)
      .fill(rgb)
      .flat()
  })
)
let cleaned
await withNativeWorkspace(
  executable,
  async ({ root, session }) => {
    const invoke = async (...args) => {
      const { stdout } = await run(process.execPath, [installedCli, ...args, '--session', session], {
        cwd: root,
        timeout: 32000
      })
      return JSON.parse(stdout)
    }
    const input = path.join(root, 'Installed fixture.png')
    await writeFile(input, source)
    await invoke('import', input)
    const state = await invoke('state')
    assert.equal(state.photos.length, 1)
    assert.equal(state.photos[0].name, 'Installed fixture.png')
    await invoke('select', '--id', state.photos[0].id)
    const preview = await invoke('preview', '--output', path.join(root, 'preview.png'))
    const { width, height, data } = readPng(await readFile(preview.path))
    assert.deepEqual([width, height], [32, 24])
    for (let offset = 0; offset < data.length; offset += 4) {
      assert.deepEqual(
        Array.from(data.subarray(offset, offset + 4), (value) => Math.round(value * 255)),
        [...rgb, 255]
      )
    }
    const original = await invoke(
      'export',
      '--format',
      'original',
      '--output',
      path.join(root, 'original.png')
    )
    assert.deepEqual(await readFile(original.path), source)
    assert.deepEqual(await readFile(input), source)
    console.log(
      JSON.stringify({
        installedCli: 'passed',
        dimensions: [width, height],
        rgb,
        originalBytes: source.length
      })
    )
  },
  {
    env: { OPENLR_DIAGNOSTICS: '1' },
    onCleanup() {
      cleaned = true
    }
  }
)
assert.equal(cleaned, true)
