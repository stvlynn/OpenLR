import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { makePng } from '../tests/fixtures/png.mjs'
import { readPng } from '../web/png.js'

const [executable, bundledCli] = process.argv.slice(2)
if (!executable || !bundledCli || process.platform !== 'darwin')
  throw Error('Pass the macOS application executable and its bundled CLI')
const cli = path.resolve(bundledCli)
const root = await mkdtemp(path.join(await realpath(tmpdir()), 'olr-cold-'))
const session = path.join(root, 'agent.json')
const run = promisify(execFile)
const env = {
  ...process.env,
  OPENLR_APP: '',
  OPENLR_AGENT_FILE: session,
  OPENLR_EPHEMERAL: '1',
  OPENLR_LOCAL_FILE: path.join(root, 'folders.json'),
  OPENLR_EXTERNAL_FILE: path.join(root, 'external.json'),
  OPENLR_SHARE_FILE: path.join(root, 'sharing.json'),
  OPENLR_CAMERA_DIRECTORY: path.join(root, 'captures'),
  WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview2'),
  APPDATA: root,
  LOCALAPPDATA: root,
  XDG_CONFIG_HOME: root,
  XDG_DATA_HOME: root,
  XDG_CACHE_HOME: root,
  XDG_RUNTIME_DIR: root
}
const invoke = async (...args) => JSON.parse((await run(process.execPath, [cli, ...args], {
  cwd: root, env, windowsHide: true, timeout: 60000
})).stdout)
let pid
try {
  assert.ok(Buffer.byteLength(path.join(root, `mygo-${process.getuid()}-000000000000.sock`)) < 100)
  const dry = await invoke('open', '--dry-run')
  assert.equal(await realpath(dry.executable), await realpath(executable))
  assert.equal(dry.session, session)
  const start = await invoke('open')
  const descriptor = JSON.parse(await readFile(session, 'utf8'))
  assert.equal(start.launched, true)
  assert.ok(Number.isSafeInteger(start.pid) && start.pid > 0 && start.pid !== process.pid)
  assert.equal(start.pid, descriptor.pid)
  pid = start.pid
  assert.equal(start.state.photo, null)
  const input = path.join(root, 'cold.png')
  const source = Buffer.from(makePng({ width: 4, height: 3, bits: 8, data: Array(12).fill([32, 64, 96]).flat() }))
  await writeFile(input, source)
  const imported = await invoke('import', input)
  assert.deepEqual(imported.failed, [])
  assert.equal(imported.added.length, 1)
  await invoke('select', '--id', imported.added[0])
  const attached = await invoke('open')
  assert.equal(attached.launched, false)
  assert.equal(attached.state.photo.id, imported.added[0])
  assert.equal(JSON.parse(await readFile(session, 'utf8')).pid, pid)
  const preview = await invoke('preview', '--output', path.join(root, 'preview.png'))
  const { width, height, data } = readPng(await readFile(preview.path))
  assert.deepEqual([width, height], [4, 3])
  assert.deepEqual(Array.from(data.subarray(0, 4), (value) => Math.round(value * 255)), [32, 64, 96, 255])
  const original = await invoke('export', '--format', 'original', '--output', path.join(root, 'original.png'))
  assert.deepEqual(await readFile(original.path), source)
  assert.deepEqual(await readFile(input), source)
  console.log(JSON.stringify({ discovered: true, coldLaunch: true, sameOwner: true, attached: true, dimensions: [width, height], originalBytes: source.length }))
} finally {
  if (pid) {
    process.kill(pid)
    for (let attempt = 0; ; attempt++) {
      try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error }
      assert.ok(attempt < 30, 'Isolated host did not exit')
      await delay(150)
    }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
console.log(JSON.stringify({ cleanupConfirmed: true }))
