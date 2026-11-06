import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url)),
  suffix = process.platform === 'win32' ? '.exe' : ''
const app = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'build', 'smoke' + suffix)
const bundledGo = path.join(root, '.tools', 'go', 'bin', 'go' + suffix),
  go = process.env.GO_BINARY || (existsSync(bundledGo) ? bundledGo : 'go')
const build = path.join(root, 'build', 'acceptance')
mkdirSync(build, { recursive: true })
const env = { ...process.env, OPENLR_EPHEMERAL: '1', OPENLR_DIAGNOSTICS: '1' }
if (existsSync(bundledGo)) {
  env.GOPATH ??= path.join(root, '.tools', 'gopath')
  env.GOCACHE ??= path.join(root, '.tools', 'gocache')
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (!process.argv[2]) run(go, ['build', '-o', app, '.'])
const editor = path.join(build, 'test-editor' + suffix),
  share = path.join(build, 'openlr-share' + suffix)
run(go, ['build', '-o', editor, './scripts/fixtures/editor'])
run(go, ['build', '-o', share, './cmd/openlr-share'])
for (const [name, ...args] of [
  ['native-smoke'],
  ...(process.platform === 'win32' ? [['native-sync-smoke']] : []),
  ['native-organization-smoke'],
  ['native-mask-smoke'],
  ['native-local-tools-smoke'],
  ['native-depth-smoke'],
  ['native-enhance-smoke'],
  ['native-culling-smoke'],
  ['native-optics-smoke'],
  ['native-navigation-smoke'],
  ['native-video-smoke'],
  ['native-local-smoke'],
  ['native-migration-smoke'],
  ['native-external-smoke', editor],
  ['native-camera-smoke'],
  ['native-sharing-smoke', share],
  ['native-integration-smoke']
])
  run(process.execPath, ['scripts/' + name + '.mjs', app, ...args])
