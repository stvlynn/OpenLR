import test from 'node:test'
import assert from 'node:assert/strict'
import initSqlJs from 'sql.js'
import { createHash } from 'node:crypto'
import { scanCatalog, scalarDevelop, relativeResource, xmpText } from '../web/migration-core.js'
import { makeLrcat } from './fixtures/lrcat.mjs'

test('Classic adapter reads explicit SQLite relationships, compressed XMP and virtual copies without mutating source bytes', async () => {
  const SQL = await initSqlJs(),
    bytes = await makeLrcat(),
    hash = createHash('sha256').update(bytes).digest('hex')
  const plan = await scanCatalog(new File([bytes], 'synthetic.lrcat'), SQL)
  assert.equal(plan.sourceSha256, hash)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash)
  assert.equal(plan.photos.length, 5)
  assert.equal(plan.albums.length, 1)
  assert.equal(plan.albums[0].name, 'synthetic / Trips / Test album')
  const first = plan.photos.find((row) => row.sourceId === '201'),
    copy = plan.photos.find((row) => row.sourceId === '203')
  assert.equal(first.relative, 'Album/first.png')
  assert.equal(first.sourcePath, 'Z:/synthetic-originals/Album/first.png')
  assert.equal(first.rating, 4)
  assert.equal(first.flag, 'pick')
  assert.equal(first.keywords, 'Synthetic')
  assert.equal(first.colorLabel, 'red')
  assert.equal(first.develop.Exposure2012, 0.75)
  assert.ok(first.xmp.includes('crs:Vibrance="20"'))
  assert.equal(copy.originalId, first.id)
  assert.equal(plan.photos.find((row) => row.sourceId === '204').error, 'incomplete-catalog-record')
  assert.ok(plan.warnings.some((row) => row.code === 'smart-collections'))
  const revised = await scanCatalog(
    new File([await makeLrcat({ version: 'future-unvalidated' })], 'synthetic.lrcat'),
    SQL
  )
  assert.equal(revised.schemaVersion, 'future-unvalidated')
  assert.equal(revised.id, plan.id)
  assert.deepEqual(
    revised.photos.map((row) => row.id),
    plan.photos.map((row) => row.id)
  )
  assert.match(plan.schemaPolicy, /capabilities/)
  await assert.rejects(
    scanCatalog(new File([await makeLrcat({ broken: true })], 'bad.lrcat'), SQL),
    /Unsupported Classic catalog schema/
  )
  await assert.rejects(scanCatalog(new File(['not SQLite'], 'wrong.lrcat'), SQL), /not an unencrypted SQLite/)
})

test('develop parsing never evaluates code or nested fields; resource paths stay relative; invalid XMP encoding is rejected', async () => {
  assert.deepEqual(
    scalarDevelop(
      's={Exposure2012=1.25, Nested={Exposure2012=-5}, ConvertToGrayscale=true, CameraProfile="Adobe Standard"}'
    ),
    { Exposure2012: 1.25, ConvertToGrayscale: true, CameraProfile: 'Adobe Standard' }
  )
  assert.deepEqual(scalarDevelop('s={Exposure2012=(globalThis.executed=true),Contrast2012=10}'), {
    Contrast2012: 10
  })
  assert.equal(globalThis.executed, undefined)
  assert.deepEqual(scalarDevelop('{"Exposure2012":1,"nested":{"Exposure2012":-5}}'), { Exposure2012: 1 })
  for (const path of [
    '../private.png',
    '/Users/private.png',
    'C:\\private.png',
    'Album/../private.png',
    'Album//a.png'
  ])
    assert.throws(() => relativeResource(path), /inside/)
  assert.equal(relativeResource('Album\\photo.png'), 'Album/photo.png')
  await assert.rejects(xmpText(new Uint8Array([0, 0, 0, 20, 0, 0, 0])), /./)
})
