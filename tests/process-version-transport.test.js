import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { Organization, namedVersion, findVersion } from '../web/organization.js'

test('process metadata does not mark neutral photos edited and snapshots preserve recipe versions', () => {
  const organization = new Organization()
  organization.setFilters({ edited: 'no' })
  for (const edit of [{}, { processVersion: 1 }, { processVersion: 2 }, { processVersion: 2, Exposure: 0 }])
    assert.equal(organization.matches({ rating: 0, flag: '', edit }), true)
  assert.equal(organization.matches({ rating: 0, flag: '', edit: { processVersion: 2, Exposure: 1 } }), false)
  const source = { id: 'source', edit: { processVersion: 2, Exposure: 0.5 } },
    target = { id: 'target', edit: { processVersion: 1, Contrast: 8 } }
  organization.copy(source)
  const pasted = organization.pasted(target),
    version = namedVersion(source, 'Float edit')
  source.edit.Exposure = 1
  assert.deepEqual(pasted, { processVersion: 2, Exposure: 0.5 })
  assert.deepEqual(findVersion({ versions: [version] }, version.id).edit, pasted)
  organization.copy(source, ['Exposure'])
  assert.deepEqual(organization.pasted(target), { processVersion: 1, Contrast: 8, Exposure: 1 })
  organization.copy({ id: 'legacy', edit: { Exposure: -1 } })
  assert.deepEqual(organization.pasted(target), { Exposure: -1 })
  assert.throws(() => organization.copy({ id: 'future', edit: { processVersion: 3 } }), /version/i)
  assert.throws(() => namedVersion({ edit: { processVersion: '2' } }, 'Invalid'), /version/i)
  assert.throws(
    () => findVersion({ versions: [{ id: 'future', edit: { processVersion: 3 } }] }, 'future'),
    /version/i
  )
})

test('browser XMP and persisted presets retain explicit process versions and depth recipes without migrating legacy records', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const { exportXmp, readXmp } = await import('./xmp.js'),
      { Presets } = await import('./presets.js'),
      { all, save } = await import('./catalog.js'),
      { encodeSoftMask } = await import('./soft-mask.js'),
      { validateDepthSettings } = await import('./depth-effects.js'),
      { validateLocalTool } = await import('./local-tools.js')
    const localTools = {
      masks: [
        validateLocalTool('mask', {
          type: 'linear',
          start: { x: 0, y: 0 },
          end: { x: 1, y: 1 },
          adjustments: { Exposure: 0.25 }
        })
      ],
      repairs: [],
      depth: {
        raster: encodeSoftMask({ width: 2, height: 1, mask: Uint8Array.from([12, 244]) }),
        provenance: { model: 'generated-test-field', sourceWidth: 2, sourceHeight: 1 },
        metrics: { inferenceMs: 1 }
      },
      lensBlur: validateDepthSettings({ enabled: true, min: 0.4, max: 0.7, amount: 0.1 })
    }
    const roundtrips = [
      { Exposure: 0.5 },
      { processVersion: 1, Exposure: 0.5 },
      { processVersion: 2, Exposure: 0.5, localTools }
    ].map((edit) => ({
      original: edit,
      restored: readXmp(exportXmp({ edit, rating: 4, flag: 'pick', keywords: 'depth, test' }))
    }))
    const failure = (work) => {
      try {
        work()
        return null
      } catch (error) {
        return error.message
      }
    }
    const invalidVersions = [0, 3, 1.5, '2', null].map((value) => ({
      exported: failure(() => exportXmp({ edit: { processVersion: value } })),
      imported: failure(() =>
        readXmp(
          exportXmp({ edit: { processVersion: 2 } }).replace(
            '&quot;processVersion&quot;:2',
            '&quot;processVersion&quot;:' + JSON.stringify(value).replaceAll('"', '&quot;')
          )
        )
      )
    }))
    const malformed = [
      { ...localTools, depth: { raster: { ...localTools.depth.raster, width: 3 } } },
      { ...localTools, lensBlur: { amount: 0.9 } },
      { ...localTools, lensBlur: { min: 0.9, max: 0.1 } },
      { ...localTools, lensBlur: null }
    ].map((tools) => failure(() => readXmp(exportXmp({ edit: { processVersion: 2, localTools: tools } }))))
    const oldPreset = { id: 'legacy-transport', name: 'Legacy', edit: { Exposure: -0.5 } }
    await save('presets', oldPreset)
    const presets = new Presets()
    await presets.load()
    const current = await presets.create('Linear', {
        processVersion: 2,
        Exposure: 0.5,
        crop: { x: 0, y: 0, w: 0.5, h: 1 }
      }),
      explicitLegacy = await presets.create('Legacy explicit', { processVersion: 1, Contrast: 4 }),
      implicitLegacy = await presets.create('Legacy implicit', { Exposure: 1 })
    const restarted = new Presets()
    await restarted.load()
    return {
      roundtrips,
      localTools,
      invalidVersions,
      malformed,
      presets: [
        restarted.get(current.id),
        restarted.get(explicitLegacy.id),
        restarted.get(implicitLegacy.id)
      ].map((preset) => preset.edit),
      oldPreset,
      oldStored: (await all('presets')).find((preset) => preset.id === oldPreset.id),
      oldLoaded: restarted.get(oldPreset.id),
      builtIn: restarted.get('mono').edit,
      invalidPreset: await presets.create('Unsupported', { processVersion: 3 }).then(
        () => null,
        (error) => error.message
      )
    }
  })
  for (const { original, restored } of result.roundtrips) {
    assert.deepEqual(restored.edit, original)
    assert.equal(restored.rating, 4)
    assert.equal(restored.flag, 'pick')
    assert.equal(restored.keywords, 'depth, test')
  }
  assert.deepEqual(result.roundtrips[2].restored.edit.localTools, result.localTools)
  for (const errors of result.invalidVersions) {
    assert.match(errors.exported, /version/i)
    assert.match(errors.imported, /version/i)
  }
  for (const error of result.malformed) assert.match(error, /soft-mask|lens blur|minimum/i)
  assert.deepEqual(result.presets, [
    { processVersion: 2, Exposure: 0.5 },
    { processVersion: 1, Contrast: 4 },
    { Exposure: 1 }
  ])
  assert.deepEqual(result.oldStored, result.oldPreset)
  assert.deepEqual(result.oldLoaded, result.oldPreset)
  assert.equal(Object.hasOwn(result.builtIn, 'processVersion'), false)
  assert.match(result.invalidPreset, /version/i)
})
