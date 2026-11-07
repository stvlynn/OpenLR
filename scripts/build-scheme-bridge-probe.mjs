import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withDiagnosticBuildStage } from './native-startup-build.mjs'

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const moduleName = 'github.com/egoist/mygo'
const version = 'v0.7.4'
const output = path.resolve(root, process.argv[2] || 'build/scheme-bridge-probe')
if (!output.startsWith(root + path.sep)) throw Error('Build output must remain inside this workspace')
const bundled = path.join(root, '.tools', 'go', 'bin', 'go.exe')
const go = process.env.GO_BINARY || (existsSync(bundled) ? bundled : 'go')
const env = { ...process.env, GOWORK: 'off', CGO_ENABLED: '0' }
if ((env.GOOS || (process.platform === 'darwin' ? 'darwin' : '')) !== 'darwin')
  throw Error('This diagnostic targets Darwin; use GOOS=darwin for a compilation-only cross-check')
if (/(?:^|[\s'"])-{1,2}(?:modfile|overlay)(?:[=\s'"]|$)/.test(env.GOFLAGS ?? ''))
  throw Error('Clear custom module/overlay flags before building this isolated diagnostic')

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`${path.basename(command)} ${args[0]} failed (${result.status})`)
  return result.stdout
}

const selected = JSON.parse(run(go, ['list', '-m', '-json', moduleName], true))
if (selected.Version !== version || selected.Replace)
  throw Error(`Expected the project's unmodified MyGo ${version}`)
const sourceDirectory =
  selected.Dir || JSON.parse(run(go, ['mod', 'download', '-json', `${moduleName}@${version}`], true)).Dir
if (!sourceDirectory) throw Error('Pinned MyGo source directory was not available')
mkdirSync(output, { recursive: true })
withDiagnosticBuildStage(root, (scratch) => {
  const copy = path.join(scratch, 'mygo')
  cpSync(sourceDirectory, copy, { recursive: true })
  for (const name of [
    'bridge.go',
    'internal/bridge/bridge.go',
    'internal/darwin/window.go',
    'internal/darwin/webview.go',
    'internal/darwin/scheme.go'
  ]) {
    chmodSync(path.join(copy, name), 0o644)
    const file = path.join(copy, name)
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('\r\n', '\n'))
  }
  // The upstream generated bundle's stable transport function is patched by
  // bridge.Script at injection time; reject a different upstream layout.
  if (!readFileSync(path.join(copy, 'internal/bridge/bridge.js'), 'utf8').includes('function ge(e){'))
    throw Error('Pinned bridge bundle does not have the expected transport entry')
  const relative = (file) => path.relative(root, file).replaceAll(path.sep, '/')
  const patch = path.join(scratch, 'candidate.patch')
  writeFileSync(
    patch,
    readFileSync(path.join(root, 'scripts/fixtures/scheme-bridge/mygo-v0.7.4.patch'), 'utf8').replaceAll(
      '\r\n',
      '\n'
    )
  )
  const patchArgs = [`--directory=${relative(copy)}`, patch]
  run('git', ['apply', '--check', ...patchArgs])
  run('git', ['apply', ...patchArgs])
  const modfile = path.join(scratch, 'diagnostic.mod')
  copyFileSync(path.join(root, 'go.mod'), modfile)
  copyFileSync(path.join(root, 'go.sum'), path.join(scratch, 'diagnostic.sum'))
  run(go, ['mod', 'edit', `-modfile=${modfile}`, `-replace=${moduleName}=${copy}`])
  env.GOFLAGS = [env.GOFLAGS, `-modfile=${relative(modfile)}`].filter(Boolean).join(' ')
  run(go, ['build', '-o', path.join(output, 'scheme-bridge-probe'), './scripts/fixtures/scheme-bridge'])
  const buildInfo = run(go, ['version', '-m', path.join(output, 'scheme-bridge-probe')], true)
  writeFileSync(path.join(output, 'build-info.txt'), buildInfo)
  writeFileSync(
    path.join(output, 'build.json'),
    JSON.stringify(
      {
        candidate: 'OpenLR local-frontend scheme transport; diagnostic only',
        mygo: version,
        sourceRevision: run('git', ['rev-parse', 'HEAD'], true).trim(),
        goos: env.GOOS || 'darwin',
        goarch: env.GOARCH || process.arch,
        sourcePatch: 'scripts/fixtures/scheme-bridge/mygo-v0.7.4.patch',
        disposableModuleRemovedAfterBuild: true
      },
      null,
      2
    ) + '\n'
  )
})
