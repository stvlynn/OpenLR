import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const moduleName = 'github.com/egoist/mygo'
const version = 'v0.7.4'
const patch = path.join(root, 'scripts', 'fixtures', 'mygo-startup', `mygo-${version}.patch`)
const output = 'build/startup-diagnostic'

function run(command, args, env, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`${path.basename(command)} ${args[0]} failed (${result.status})`)
  return result.stdout
}

export function withDiagnosticBuildStage(workspace, build) {
  const staging = path.join(realpathSync(workspace), '.workspace')
  mkdirSync(staging, { recursive: true })
  if (realpathSync(staging) !== staging) throw Error('Expected private staging inside the workspace')
  const scratch = mkdtempSync(path.join(staging, 'mygo-startup-'))
  let buildFailed = false
  try {
    return build(scratch)
  } catch (error) {
    buildFailed = true
    throw error
  } finally {
    try {
      const resolved = realpathSync(scratch)
      if (resolved !== scratch || path.dirname(resolved) !== staging)
        throw Error('Refusing to remove a non-diagnostic workspace')
      rmSync(resolved, { recursive: true, force: true })
    } catch (error) {
      if (!buildFailed) throw error
      console.error('Could not clean the diagnostic build workspace', error.message)
    }
  }
}

function build() {
  if (process.platform !== 'win32') throw Error('Build the WebView2 diagnostic package on Windows')
  const bundled = path.join(root, '.tools', 'go', 'bin', 'go.exe')
  const go = process.env.GO_BINARY || (existsSync(bundled) ? bundled : 'go')
  const env = { ...process.env, GOWORK: 'off' }
  if (go === bundled) {
    env.GOPATH ??= path.join(root, '.tools', 'gopath')
    env.GOCACHE ??= path.join(root, '.tools', 'gocache')
  }
  if (/(?:^|[\s'"])-{1,2}(?:modfile|overlay)(?:[=\s'"]|$)/.test(env.GOFLAGS ?? ''))
    throw Error('Clear custom Go module and overlay flags before building the startup diagnostic')

  const selected = JSON.parse(run(go, ['list', '-m', '-json', moduleName], env, true))
  if (selected.Version !== version || selected.Replace) throw Error(`Expected unmodified MyGo ${version}`)
  const source = JSON.parse(run(go, ['mod', 'download', '-json', `${moduleName}@${version}`], env, true))
  const checksum = readFileSync(path.join(root, 'go.sum'), 'utf8')
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${moduleName} ${version} `))
  if (!source.Dir || !source.Sum || checksum !== `${moduleName} ${version} ${source.Sum}`)
    throw Error('MyGo source did not match the project checksum')
  run(go, ['mod', 'verify'], env)

  withDiagnosticBuildStage(root, (scratch) => {
    const moduleCopy = path.join(scratch, 'mygo')
    cpSync(source.Dir, moduleCopy, { recursive: true })
    for (const file of ['webview.go', 'webview2.go', 'window.go'])
      chmodSync(path.join(moduleCopy, 'internal', 'windows', file), 0o644)
    const relative = (file) => path.relative(root, file).replaceAll(path.sep, '/')
    const patchArgs = [`--directory=${relative(moduleCopy)}`, patch]
    run('git', ['apply', '--check', ...patchArgs], env)
    run('git', ['apply', ...patchArgs], env)

    const modfile = path.join(scratch, 'diagnostic.mod')
    copyFileSync(path.join(root, 'go.mod'), modfile)
    copyFileSync(path.join(root, 'go.sum'), path.join(scratch, 'diagnostic.sum'))
    run(go, ['mod', 'edit', `-modfile=${modfile}`, `-replace=${moduleName}=${moduleCopy}`], env)
    env.GOFLAGS = [env.GOFLAGS, `-modfile=${relative(modfile)}`].filter(Boolean).join(' ')
    run(go, ['tool', 'mygo', 'build', '-platform', 'windows/amd64', '-skip-installer', '-o', output], env)
  })
}

if (import.meta.main) build()
