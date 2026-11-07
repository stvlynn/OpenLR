import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundled = path.join(root, '.tools', 'go', 'bin', process.platform === 'win32' ? 'go.exe' : 'go')
const go = process.env.GO_BINARY || (existsSync(bundled) ? bundled : 'go')

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`${path.basename(command)} ${args[0]} failed (${result.status})`)
}

// Regeneration deliberately starts with Go's selected upstream dependencies.
// The app-specific adaptation is applied once to that fresh vendor tree.
run(go, ['mod', 'vendor'])
const modules = readFileSync(path.join(root, 'vendor', 'modules.txt'), 'utf8')
if (!/^# github\.com\/egoist\/mygo v0\.7\.4\r?$/m.test(modules))
  throw Error('Update the version-specific MyGo bridge patch for the selected dependency')
const moduleDirectory = 'vendor/github.com/egoist/mygo'
for (const relative of [
  'bridge.go',
  'internal/bridge/bridge.go',
  'internal/darwin/window.go',
  'internal/darwin/webview.go',
  'internal/darwin/scheme.go'
]) {
  const file = path.join(root, moduleDirectory, relative)
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('\r\n', '\n'))
}
const patch = path.join(root, 'scripts', 'mygo', 'darwin-local-bridge.patch')
run('git', ['apply', '--check', `--directory=${moduleDirectory}`, patch])
run('git', ['apply', `--directory=${moduleDirectory}`, patch])
