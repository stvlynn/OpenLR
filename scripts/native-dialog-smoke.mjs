import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { withNativeWorkspace } from './native-workspace.mjs'
import { makePng } from '../tests/fixtures/png.mjs'
import { readPng } from '../web/png.js'

const executable = process.argv[2]
if (process.platform !== 'darwin' || !executable)
  throw Error('Pass a packaged macOS OpenLR executable on a logged-in desktop')
const bundle = path.resolve(path.dirname(executable), '../..')
assert.equal(path.extname(bundle), '.app')
const exec = promisify(execFile)
const driver = fileURLToPath(new URL('drive-native-dialog.applescript', import.meta.url))

// The same stock osascript client drives the panels. This check does not request trust.
const trust = await exec(
  '/usr/bin/osascript',
  ['-l', 'JavaScript', '-e', 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()'],
  { timeout: 8_000 }
)
console.log('Direct stock osascript Accessibility trust: ' + trust.stdout.trim())

async function until(label, observe) {
  const deadline = Date.now() + 10_000
  do {
    const result = await observe()
    if (result) return result
    await delay(120)
  } while (Date.now() < deadline)
  throw Error(`Timed out waiting for ${label}`)
}

await withNativeWorkspace(executable, async ({ root, call, pid, initial }) => {
  const run = (command, args) => call(command, '--args', JSON.stringify(args))
  const ax = async (...args) => {
    const { stdout } = await exec('/usr/bin/osascript', [driver, String(pid), ...args], { timeout: 8_000 })
    return stdout.trim()
  }
  const observe = (kind) => ax('observe', kind)
  const waitForPanel = async (kind) => {
    const witness = await until(`native ${kind} panel`, async () => {
      const observed = await observe(kind)
      return observed !== 'pending' && observed
    })
    assert.match(witness, /^AX(?:Sheet|Window) (?:Open|Choose|Save) \/ Cancel$/)
    console.log(`${kind} panel: ${witness}`)
  }
  const waitForDismissal = (kind) =>
    until(`native ${kind} panel dismissal`, async () => (await observe(kind)) === 'pending')
  const navigate = async (kind, directory) => {
    // Keep the keyboard input ASCII and constrain it to the disposable workspace.
    assert.ok(directory.startsWith(root + path.sep) && /^\/[A-Za-z0-9_./-]+$/.test(directory))
    assert.equal(await ax('navigate', kind, directory + '/'), 'entered path')
  }
  const choose = async (kind, directory) => {
    await navigate(kind, directory)
    await until(`native ${kind} panel approval`, async () => (await ax('accept', kind)) === 'accepted')
    await waitForDismissal(kind)
  }
  const cancel = async (kind) => {
    assert.equal(await ax('cancel', kind), 'canceled')
    await waitForDismissal(kind)
  }

  assert.deepEqual(initial.photos, [])
  assert.equal(await ax('preflight'), 'Export with previous settings')
  assert.equal(await observe('folder'), 'pending')
  assert.equal(await observe('save'), 'pending')
  console.log('System Events Accessibility preflight passed for the owned OpenLR process')

  const source = path.join(root, 'panel-source')
  const destination = path.join(root, 'panel-destination')
  const filename = 'panel-fixture.png'
  const fixture = path.join(source, filename)
  const rgb = [37, 82, 119]
  const pixels = Array(32 * 24).fill(rgb).flat()
  const bytes = Buffer.from(makePng({ width: 32, height: 24, bits: 8, data: pixels }))
  await mkdir(source)
  await mkdir(destination)
  await writeFile(fixture, bytes)

  function requestFolder() {
    const pending = call('local-open')
    pending.catch(() => {})
    return pending
  }

  const canceledFolder = requestFolder()
  await waitForPanel('folder')
  await cancel('folder')
  assert.deepEqual(await canceledFolder, { canceled: true })
  assert.deepEqual(await call('local-folders'), [])
  assert.deepEqual((await call('state')).photos, [])

  const acceptedFolder = requestFolder()
  await waitForPanel('folder')
  await choose('folder', source)
  const opened = await acceptedFolder
  assert.equal(opened.photos, 1)
  assert.equal(opened.folder.root.path, source)
  const [photo] = (await call('state')).photos
  assert.equal(photo.name, filename)
  await call('select', '--id', photo.id)
  const preview = await call('preview', '--output', path.join(root, 'preview.png'))
  assert.equal(preview.mimeType, 'image/png')
  const { width, height, data } = readPng(await readFile(preview.path))
  assert.deepEqual([width, height], [32, 24])
  for (let index = 0; index < data.length; index += 4)
    assert.deepEqual(Array.from(data.subarray(index, index + 4), (value) => Math.round(255 * value)), [
      ...rgb,
      255
    ])
  await run('export-settings', { media: 'photo', options: { format: 'original' } })

  assert.equal(await ax('open-save'), 'menu action')
  await waitForPanel('save')
  await navigate('save', destination)
  await cancel('save')
  assert.deepEqual(await readdir(destination), [])

  assert.equal(await ax('open-save'), 'menu action')
  await waitForPanel('save')
  await choose('save', destination)
  const saved = path.join(destination, filename)
  const actual = await until('published original bytes', async () =>
    readFile(saved).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  )
  assert.deepEqual(actual, bytes)
  assert.deepEqual(await readdir(destination), [filename])
  assert.deepEqual(await readFile(fixture), bytes)
  assert.equal((await call('state')).selected, photo.id)
  console.log(`Native macOS folder and Save panels accepted and canceled; verified ${bytes.length} original bytes`)
})
