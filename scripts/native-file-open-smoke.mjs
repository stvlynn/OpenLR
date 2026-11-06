import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { makePng } from '../tests/fixtures/png.mjs'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const executable = process.argv[2]
const mac = process.platform === 'darwin'
if (!executable || (!mac && process.platform !== 'win32'))
  throw Error('Pass a packaged Windows or macOS executable')
const exec = promisify(execFile)
const bundle = mac && path.resolve(path.dirname(executable), '../..')
if (mac) {
  assert.equal(path.extname(bundle), '.app')
  const { stdout } = await exec('/usr/bin/plutil', [
    '-extract', 'CFBundleDocumentTypes', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')
  ])
  assert.ok(JSON.parse(stdout).some((type) => type.CFBundleTypeExtensions?.includes('png')))
}

const fixtures = [
  { name: 'First launch.png', rgb: [39, 82, 131], width: 32, height: 24 },
  { name: 'Second café.PNG', rgb: [166, 84, 40], width: 30, height: 22 }
]
let source

async function prepare({ root }) {
  source = path.join(root, 'source')
  await mkdir(source)
  for (const fixture of fixtures) {
    const { name, width, height, rgb } = fixture
    fixture.file = path.join(source, name)
    fixture.bytes = Buffer.from(
      makePng({
        width,
        height,
        bits: 8,
        data: Array(width * height)
          .fill(rgb)
          .flat()
      })
    )
    await writeFile(fixture.file, fixture.bytes)
  }
  return mac ? [] : [fixtures[0].file]
}

await withNativeWorkspace(
  executable,
  async ({ root, session, initial, pid, call, restart, launchSecondary }) => {
    const readPid = async () => JSON.parse(await readFile(session, 'utf8')).pid
    assert.equal(await readPid(), pid)
    const [first, second] = fixtures

    async function opened({ name }, count) {
      // OS delivery schedules import asynchronously. Only observe while waiting.
      const deadline = Date.now() + 12000
      for (;;) {
        const state = await call('state')
        const photo = state.photos.find(({ id }) => id === state.selected)
        const sameName = mac ? photo?.name.normalize() === name.normalize() : photo?.name === name
        if (state.mode === 'detail' && sameName && state.photos.length === count) return photo
        if (Date.now() > deadline)
          assert.fail(
            `Expected ${name} in Detail with ${count} photos, saw ${state.mode} and ${state.photos.map(({ name }) => name).join(', ')}`
          )
        await delay(100)
      }
    }

    async function verifySelected(fixture, label) {
      for (const [command, args] of [
        ['preview', []],
        ['export', ['--format', 'image/png']]
      ]) {
        const result = await call(
          command,
          ...args,
          '--output',
          path.join(root, label + '-' + command + '.png')
        )
        assert.equal(result.mimeType, 'image/png')
        const { width, height, data } = readPng(await readFile(result.path))
        assert.deepEqual([width, height], [fixture.width, fixture.height])
        for (let i = 0; i < data.length; i += 4)
          assert.deepEqual(
            Array.from(data.subarray(i, i + 4), (value) => Math.round(255 * value)),
            [...fixture.rgb, 255]
          )
      }
      const original = await call(
        'export',
        '--format',
        'original',
        '--output',
        path.join(root, label + '-original.png')
      )
      assert.deepEqual(await readFile(original.path), fixture.bytes)
      assert.deepEqual(await readFile(fixture.file), fixture.bytes)
    }

    async function forward(fixture) {
      if (mac) await exec('/usr/bin/open', ['-a', bundle, fixture.file], { timeout: 8000 })
      else {
        const secondary = launchSecondary([fixture.name], source)
        assert.deepEqual(
          await Promise.race([
            once(secondary, 'close'),
            delay(5000, undefined, { ref: false }).then(() => {
              throw Error('Second instance did not exit')
            })
          ]),
          [0, null]
        )
        await assert.rejects(access(path.join(root, 'secondary-agent.json')), { code: 'ENOENT' })
      }
      assert.equal(await readPid(), pid)
    }
    if (mac) {
      assert.deepEqual(initial.photos, [])
      await forward(first)
    }
    const firstPhoto = await opened(first, 1)
    assert.deepEqual(firstPhoto.edit, {})
    await verifySelected(first, 'first')

    await forward(second)
    const secondPhoto = await opened(second, 2)
    assert.notEqual(secondPhoto.id, firstPhoto.id)
    await verifySelected(second, 'second')
    await call('view', '--mode', 'grid')
    await forward(second)
    assert.equal((await opened(second, 2)).id, secondPhoto.id)
    assert.equal(await readPid(), pid)

    if (!mac) {
      const reopened = await restart()
      assert.deepEqual(new Set(reopened.photos.map(({ id }) => id)), new Set([firstPhoto.id, secondPhoto.id]))
      for (const [fixture, id] of [
        [first, firstPhoto.id],
        [second, secondPhoto.id]
      ]) {
        await call('select', '--id', id)
        await verifySelected(fixture, 'reopen-' + fixture.width)
      }
    }
    console.log(
      JSON.stringify({
        nativeFileOpen: 'passed',
        delivery: mac ? 'Launch Services to a running app' : 'executable arguments',
        first: {
          input: 'absolute path with spaces',
          dimensions: [first.width, first.height],
          rgb: first.rgb,
          bytes: first.bytes.length
        },
        second: {
          input: mac ? 'absolute Unicode path' : 'relative Unicode path from second working directory',
          dimensions: [second.width, second.height],
          rgb: second.rgb,
          bytes: second.bytes.length
        },
        primarySessionRetained: true,
        duplicateRetainedId: true,
        persistentReload: mac ? undefined : true
      })
    )
  },
  { persistent: !mac, prepare, env: { OPENLR_DIAGNOSTICS: '1' } }
)
