import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { withNativeWorkspace } from '../native-workspace.mjs'
import { readPng } from '../../web/png.js'

const [executable, fixture, directory, keyword] = process.argv.slice(2)
assert.ok(executable && fixture && directory && keyword)
const source = await realpath(directory)
const filename = path.basename(fixture)
const exported = path.join(source, filename)
const sidecar = path.join(source, path.parse(filename).name + '.xmp')
const bytes = await readFile(fixture)
const xmp = await readFile(sidecar)
assert.deepEqual((await readdir(source)).sort(), [path.basename(exported), path.basename(sidecar)].sort())
assert.deepEqual(await readFile(exported), bytes)

const exec = promisify(execFile)
const keywordPath = "//*[local-name()='subject' and namespace-uri()='http://purl.org/dc/elements/1.1/']" +
  "//*[local-name()='li' and namespace-uri()='http://www.w3.org/1999/02/22-rdf-syntax-ns#']"
const readField = async (xpath) => {
  const { stdout } = await exec('/usr/bin/xmllint', ['--nonet', '--xpath', 'string(' + xpath + ')', sidecar])
  return stdout.trim()
}
const datePath = "//*[local-name()='DateCreated' and namespace-uri()='http://ns.adobe.com/photoshop/1.0/']"
const captureDate = await readField(datePath)
assert.ok(Number.isFinite(Date.parse(captureDate)))
assert.equal(await readField(keywordPath), keyword)

const authorized = { id: 'photos-export-fixture', name: path.basename(source), path: source }
await withNativeWorkspace(
  executable,
  async ({ root, call, initial }) => {
    assert.deepEqual(initial.photos, [])
    const scan = await call('migration-apple-scan', '--root', authorized.id)
    assert.equal(scan.kind, 'apple-export')
    assert.equal(scan.total, 1)
    assert.equal(scan.available, 1)
    const migrated = await call('migration-commit', '--id', scan.id)
    assert.deepEqual(migrated.failed, [])
    assert.deepEqual(migrated.missing, [])
    assert.equal(migrated.imported.length, 1)
    const state = await call('state')
    assert.equal(state.photos.length, 1)
    const [photo] = state.photos
    assert.equal(photo.name, filename)
    assert.equal(photo.keywords, keyword)
    assert.equal(photo.metadata.DateTimeOriginal, captureDate)
    assert.equal(photo.reference.root, authorized.id)
    await call('select', '--id', photo.id)
    const preview = await call('preview', '--output', path.join(root, 'preview.png'))
    const image = readPng(await readFile(preview.path))
    assert.deepEqual([image.width, image.height], [32, 24])
    for (let offset = 0; offset < image.data.length; offset += 4)
      assert.deepEqual(Array.from(image.data.subarray(offset, offset + 4), (value) => Math.round(255 * value)), [
        64, 96, 128, 255
      ])
    const original = await call('export', '--format', 'original', '--output', path.join(root, filename))
    assert.deepEqual(await readFile(original.path), bytes)
    assert.deepEqual(await readFile(exported), bytes)
    assert.deepEqual(await readFile(sidecar), xmp)
    console.log(JSON.stringify({ genuinePhotosExport: 'passed', keyword, captureDate, dimensions: [32, 24], originalBytes: bytes.length, sidecarBytes: xmp.length }))
  },
  {
    prepare: async ({ root }) => {
      await writeFile(path.join(root, 'folders.json'), JSON.stringify([authorized]))
    }
  }
)
