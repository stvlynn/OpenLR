import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { readExifTool } from './exiftool.mjs'

const rights = '© 示例 & <rights> 📷 é'
const creator = '创作者 Example'
const fixture = new URL('./fixtures/export-metadata.png', import.meta.url)

test('all rendered formats preserve only selected metadata with unchanged pixels through Original and Linear GUI/CLI exports', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  const input = await readFile(fixture)
  await page.locator('#files').setInputFiles({ name: 'metadata.png', mimeType: 'image/png', buffer: input })
  await page.locator('#gallery .tile').waitFor()
  const source = await page.evaluate(async () => (await window.openlr.run('state')).photos[0].metadata)
  assert.equal(source.Copyright, rights)
  assert.equal(source.Artist, creator)
  assert.equal(source.DateTimeOriginal, '2024-06-07T08:09:10.125+08:00')
  const records = await page.evaluate(async () => {
    const { run } = window.openlr
    const { decodePhoto } = await import('./decode.js')
    const { metadata } = await import('./metadata.js')
    const output = []
    await run('edit', { key: 'turn', value: 1 })
    await run('edit', { key: 'crop', value: { x: 0.125, y: 0.125, w: 0.75, h: 0.75 } })
    for (const version of [1, 2]) {
      await run('processing', { version })
      for (const format of ['image/jpeg', 'image/png', 'image/tiff', 'image/avif', 'image/jxl']) {
        let baseline
        for (const policy of ['none', 'copyright', 'supported']) {
          const result = await run('export', {
            format,
            metadata: policy,
            quality: 1,
            colorSpace: 'display-p3',
            maxSize: 16
          })
          const file = new File([result.blob], result.filename, { type: format })
          let profileCorrect = true
          if (format === 'image/jxl') {
            const { decodeJxl } = await import('./color-codecs.js')
            const { makeColorProfile } = await import('./color-spaces.js')
            const actual = (await decodeJxl(await file.arrayBuffer())).originalICC
            const expected = makeColorProfile('display-p3')
            profileCorrect =
              actual.length === expected.length && actual.every((value, i) => value === expected[i])
          }
          const bitmap = await decodePhoto(file),
            canvas = document.createElement('canvas')
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const context = canvas.getContext('2d')
          context.drawImage(bitmap, 0, 0)
          bitmap.close()
          const pixels = Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data)
          if (policy === 'none') baseline = pixels
          output.push({
            version,
            format,
            policy,
            filename: `${version}-${policy}-${result.filename}`,
            width: canvas.width,
            height: canvas.height,
            profileCorrect,
            samePixels:
              pixels.length === baseline.length && pixels.every((value, i) => value === baseline[i]),
            metadata: await metadata(file, { strict: true }),
            bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer()))
          })
        }
      }
    }
    return output
  })
  await mkdir('.workspace', { recursive: true })
  const directory = await mkdtemp(path.resolve('.workspace/export-metadata-acceptance-'))
  for (const record of records) {
    assert.equal(record.samePixels, true, `${record.version} ${record.format} ${record.policy}: pixels`)
    assert.equal(record.profileCorrect, true, 'JPEG XL codestream ICC')
    assert.deepEqual([record.width, record.height], [16, 12])
    assert.equal(record.metadata.Copyright, record.policy === 'none' ? undefined : rights)
    assert.equal(record.metadata.Artist, record.policy === 'supported' ? creator : undefined)
    assert.equal(record.metadata.Make, record.policy === 'supported' ? 'OpenLR Fixture' : undefined)
    assert.equal(
      record.metadata.DateTimeOriginal,
      record.policy === 'supported' ? source.DateTimeOriginal : undefined
    )
    await writeFile(path.join(directory, record.filename), Uint8Array.from(record.bytes))
  }
  await t.test(
    'independent ExifTool reads all 30 actual files and verifies excluded source data',
    (oracleTest) => {
      const parsed = readExifTool(records.map((record) => path.join(directory, record.filename)))
      if (!parsed) return oracleTest.skip('Independent ExifTool source is not installed')
      assert.equal(parsed.length, records.length)
      for (const [i, tags] of parsed.entries()) {
        const record = records[i],
          label = `${record.version} ${record.format} ${record.policy}`
        assert.equal(tags['XMP-dc:Rights'], record.policy === 'none' ? undefined : rights, label)
        assert.equal(tags['XMP-dc:Creator'], record.policy === 'supported' ? creator : undefined, label)
        assert.equal(tags['IFD0:Make'], record.policy === 'supported' ? 'OpenLR Fixture' : undefined, label)
        assert.equal(tags['ExifIFD:ISO'], record.policy === 'supported' ? 200 : undefined, label)
        // ExifTool reads JXL metadata boxes but not its codestream ICC; libjxl checks it above.
        if (record.format !== 'image/jxl')
          assert.match(tags['ICC_Profile:ProfileDescription'], /Display P3/, label)
        if (record.policy !== 'none') {
          assert.equal(tags['IFD0:Orientation'], 1, label)
          assert.equal(tags['ExifIFD:ExifImageWidth'], 16, label)
          assert.equal(tags['ExifIFD:ExifImageHeight'], 12, label)
        }
        for (const key of Object.keys(tags)) {
          assert.ok(!key.startsWith('GPS:'), label + ' GPS')
          assert.ok(!key.startsWith('XMP-crs:'), label + ' edit settings')
          assert.ok(
            !key.endsWith(':Warning') && !key.endsWith(':Error'),
            label + ' ' + key + ': ' + tags[key]
          )
        }
        assert.equal(tags['XMP-dc:Subject'], undefined, label)
      }
    }
  )
  await page.locator('#export').click()
  await page.locator('#format').selectOption('image/png')
  await page.locator('#export-metadata').selectOption('copyright')
  const downloadEvent = page.waitForEvent('download')
  await page.locator('#export-dialog button[value=ok]').click()
  const download = await downloadEvent
  const saved = await readFile(await download.path())
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem('export-settings') || '{}').photo?.metadata === 'copyright'
  )
  const current = await page.evaluate(() => window.openlr.run('export-settings'))
  assert.equal(current.photo.metadata, 'copyright')
  const repeated = await page.evaluate(() => window.openlr.dispatch('export-previous'))
  assert.deepEqual(Buffer.from(repeated.result.base64, 'base64'), saved)
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  assert.equal((await page.evaluate(() => window.openlr.run('export-settings'))).photo.metadata, 'copyright')
  await page.locator('#export').click()
  await page.locator('#export-metadata').selectOption('supported')
  await page.locator('#export-dialog button[value=cancel]').click()
  assert.equal((await page.evaluate(() => window.openlr.run('export-settings'))).photo.metadata, 'copyright')
  const original = await page.evaluate(() => window.openlr.dispatch('export', { format: 'original' }))
  assert.deepEqual(Buffer.from(original.result.base64, 'base64'), input)
  await page.locator('#export').click()
  await page.locator('#format').selectOption('original')
  assert.equal(await page.locator('#export-metadata').isVisible(), false)
  await page.locator('#export-dialog button[value=cancel]').click()
  const refused = await page.evaluate(() =>
    window.openlr.dispatch('export', { format: 'original', metadata: 'copyright' })
  )
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /does not support photo metadata/)
  t.diagnostic(`Independent metadata files: ${directory}`)
})
