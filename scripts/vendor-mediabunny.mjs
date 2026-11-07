import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repo = fileURLToPath(new URL('..', import.meta.url))
const packagePath = path.join(repo, 'node_modules', 'mediabunny')
const { version } = JSON.parse(await readFile(path.join(packagePath, 'package.json'), 'utf8'))
assert.equal(version, '1.65.1', 'Update the MediaBunny source patch when changing the pinned version')

const workspace = path.join(repo, '.workspace')
await mkdir(workspace, { recursive: true })
const temp = await realpath(workspace)
assert.equal(path.dirname(temp), await realpath(repo))
const source = await mkdtemp(path.join(temp, 'openlr-mediabunny-'))
try {
  await Promise.all([
    cp(path.join(packagePath, 'src'), path.join(source, 'src'), { recursive: true }),
    // The npm package contains these shared modules as compiled JS.
    cp(path.join(packagePath, 'dist', 'modules', 'shared'), path.join(source, 'shared'), { recursive: true })
  ])
  execFileSync(
    'git',
    [
      'apply',
      ...['audio-timing.patch', 'video-diagnostics.patch', 'matroska-duration.patch'].map((patch) =>
        path.join(repo, 'scripts', 'mediabunny', patch)
      )
    ],
    {
      cwd: source,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: temp },
      stdio: 'inherit'
    }
  )
  await build({
    entryPoints: [path.join(source, 'src', 'index.ts')],
    outfile: process.argv[2]
      ? path.resolve(process.argv[2])
      : path.join(repo, 'web', 'vendor', 'mediabunny', 'mediabunny.mjs'),
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    // Keep the upstream browser syntax floor, including lowered resource disposal.
    target: 'es2021',
    tsconfigRaw: {},
    legalComments: 'eof',
    plugins: [
      {
        name: 'browser-node-alias',
        setup(builder) {
          // Match MediaBunny's browser build, which omits its Node file adapters.
          builder.onResolve({ filter: /^\.\/node$/ }, () => ({ path: 'node', namespace: 'empty-node' }))
          builder.onLoad({ filter: /.*/, namespace: 'empty-node' }, () => ({
            contents: 'export const fs = undefined'
          }))
        }
      }
    ]
  })
} finally {
  const cleanup = await realpath(source)
  assert.equal(path.dirname(cleanup), temp)
  assert.ok(path.basename(cleanup).startsWith('openlr-mediabunny-'))
  await rm(cleanup, { recursive: true, force: true })
}
