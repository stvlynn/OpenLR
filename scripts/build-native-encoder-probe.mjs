// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const output = path.resolve(root, process.argv[2] || 'build/native-encoder-probe')
assert.ok(output.startsWith(root + path.sep), 'Probe output must stay inside this workspace')
const go = process.env.GO_BINARY || 'go'
const env = { ...process.env, GOTOOLCHAIN: 'local', GOWORK: 'off', CGO_ENABLED: '0' }
function run(program, args) {
  const result = spawnSync(program, args, { cwd: root, env, windowsHide: true, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(result.stderr || `${program} failed (${result.status})`)
  return result.stdout
}
const version = run(go, ['version']).trim()
assert.match(version, /\bgo1\.27\.3\b/, 'Use the stock Go 1.27.3 toolchain for this comparison')
const goos = run(go, ['env', 'GOOS']).trim(),
  goarch = run(go, ['env', 'GOARCH']).trim()
const executable = path.join(output, 'native-encoder-probe' + (goos === 'windows' ? '.exe' : ''))
await mkdir(output, { recursive: true })
const buildFlags = [
  '-mod=vendor',
  '-trimpath',
  '-tags',
  'mygo_noinspector',
  '-ldflags',
  '-s -w -X github.com/egoist/mygo.production=1'
]
run(go, ['build', ...buildFlags, '-o', executable, './scripts/fixtures/encoder-probe'])
await writeFile(path.join(output, 'build-info.txt'), run(go, ['version', '-m', executable]))
await writeFile(
  path.join(output, 'build.json'),
  JSON.stringify(
    {
      go: version,
      goos,
      goarch,
      sourceRevision: run('git', ['rev-parse', 'HEAD']).trim(),
      dirty: Boolean(run('git', ['status', '--porcelain']).trim()),
      build: 'go build; standard vendored MyGo 0.7.4 with ordinary production runtime/inspector flags',
      buildFlags,
      production: true,
      executable: path.basename(executable),
      diagnosticSDK: false,
      scope: 'Public VideoEncoder configuration/feed experiment; no installed backend identification'
    },
    null,
    2
  ) + '\n'
)
await cp(path.join(root, 'scripts/fixtures/encoder-probe'), path.join(output, 'source/encoder-probe'), {
  recursive: true
})
await cp(path.join(root, 'resources/licenses'), path.join(output, 'licenses'), { recursive: true })
await cp(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'))
await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'THIRD_PARTY_NOTICES.md'))
await cp(
  path.join(root, 'web/vendor/mediabunny/LICENSE'),
  path.join(output, 'licenses/mediabunny-MPL-2.0.txt')
)
await writeFile(
  path.join(output, 'source/README.txt'),
  'OpenLR corresponding source: https://github.com/stvlynn/OpenLR\n' +
    'See build.json for the exact revision. Probe source is included; project and dependency licenses are retained.\n'
)
console.log(JSON.stringify({ nativeEncoderBuild: 'complete', executable, go: version, goos, goarch }))
