import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('new removal patches replace clone pixels without reordering historical fills or flattening other samples', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const run = window.openlr.run
    const canonical = (value) =>
      JSON.stringify(value, (_, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item
      )
    const { exportXmp } = await import('./xmp.js')
    const { COPY_GROUPS } = await import('./copy-options.js')
    const { deflateSync } = await import('./vendor/fflate/browser.js')
    const width = 96,
      height = 64,
      canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.fillStyle = '#606060'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#f51d16'
    ctx.fillRect(12, 24, 17, 17)
    const file = new File([await new Promise((resolve) => canvas.toBlob(resolve))], 'clone.png', {
      type: 'image/png'
    })
    const imported = await run('import', { files: [file] }),
      id = imported.added[0]
    const photo = async () => (await run('state')).photos.find((p) => p.id === id)
    const render = async () => {
      const { blob } = await run('export', { format: 'image/png' })
      const bitmap = await createImageBitmap(blob)
      ctx.clearRect(0, 0, width, height)
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      return ctx.getImageData(0, 0, width, height).data
    }
    const pixel = (data, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x + 1) * 4)]
    const source = { x: 20.5 / width, y: 32.5 / height },
      target = { x: 66.5 / width, y: 32.5 / height }
    const cases = []
    for (const version of [1, 2])
      for (const opacity of [1, 0.6]) {
        await run('reset')
        await run('processing', { version })
        await run('repair.add', {
          repair: { type: 'clone', source, points: [target], radius: 0.06, opacity, feather: 0 }
        })
        const radial = { type: 'radial', center: target, rx: 8 / width, ry: 8 / height, feather: 0 }
        await run('mask.add', {
          mask:
            opacity === 1
              ? {
                  type: 'composite',
                  operation: 'intersect',
                  components: [
                    radial,
                    { type: 'color-range', color: '#f51d16', tolerance: 0.01, softness: 0 }
                  ]
                }
              : radial
        })
        const beforePhoto = await photo(),
          before = await render(),
          maskId = beforePhoto.edit.localTools.masks[0].id
        await run('remove-mask', { id: maskId, algorithm: version === 1 ? 'ns' : 'telea' })
        const afterPhoto = await photo(),
          after = await render()
        let exteriorChanges = 0
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            if (Math.hypot(x - 66, y - 32) < 8) continue
            for (let c = 0; c < 4; c++)
              exteriorChanges += Number(before[(y * width + x) * 4 + c] !== after[(y * width + x) * 4 + c])
          }
        await run('undo')
        const undone = await render(),
          undoPhoto = await photo()
        await run('redo')
        const redone = await render()
        await run('repair.add', {
          repair: { type: 'clone', source, points: [target], radius: 0.06, opacity: 1, feather: 0 }
        })
        const laterClone = pixel(await render(), 66, 32)
        const anchor = (await photo()).edit.localTools.repairs.at(-1).afterFillId
        await run('mask.add', { mask: radial })
        await run('remove-mask', { algorithm: 'ns' })
        const laterRemoval = pixel(await render(), 66, 32)
        cases.push({
          version,
          opacity,
          before: pixel(before, 66, 32),
          after: pixel(after, 66, 32),
          exteriorChanges,
          laterClone,
          laterRemoval,
          anchored: anchor === afterPhoto.edit.postRepairFills[0].id && typeof anchor === 'string',
          repairRetained:
            canonical(beforePhoto.edit.localTools.repairs) === canonical(afterPhoto.edit.localTools.repairs),
          postCount: afterPhoto.edit.postRepairFills?.length ?? 0,
          legacyCount: afterPhoto.edit.fills?.length ?? 0,
          masks: afterPhoto.edit.localTools.masks.length,
          undo:
            before.every((v, i) => v === undone[i]) &&
            canonical(undoPhoto.edit) === canonical(beforePhoto.edit),
          redo: after.every((v, i) => v === redone[i])
        })
      }
    const saved = await photo(),
      savedPixels = await render(),
      xml = exportXmp(saved)
    let publicAnchorRejections = 0
    for (const [command, args] of [
      [
        'repair.add',
        { repair: { type: 'clone', source, points: [target], radius: 0.06, afterFillId: 'caller-value' } }
      ],
      [
        'repair.update',
        { id: saved.edit.localTools.repairs.at(-1).id, changes: { afterFillId: 'caller-value' } }
      ]
    ]) {
      try {
        await run(command, args)
      } catch {
        publicAnchorRejections++
      }
    }
    await run('repair.update', { id: saved.edit.localTools.repairs.at(-1).id, changes: { opacity: 0.5 } })
    const retainedAnchor =
      (await photo()).edit.localTools.repairs.at(-1).afterFillId ===
      saved.edit.localTools.repairs.at(-1).afterFillId
    await run('undo')
    const version = await run('version-save', { name: 'Removed clone' })
    await run('reset')
    await run('version-restore', { id: version.id })
    const versionEqual = canonical((await photo()).edit) === canonical(saved.edit)
    await run('reset')
    await run('apply-xmp', { xml })
    const xmpEqual = canonical((await photo()).edit) === canonical(saved.edit)
    const removalKeys = COPY_GROUPS.find((group) => group.id === 'fill').keys
    await run('copy-edits', { keys: removalKeys })
    await run('reset')
    await run('paste-edits')
    const pasted = (await photo()).edit
    await run('apply-xmp', { xml })
    await run('copy-edits', { keys: ['localTools'] })
    await run('reset')
    await run('paste-edits')
    const missingAnchorTarget = pixel(await render(), 66, 32)
    await run('apply-xmp', { xml })
    let invalidRejected = false
    try {
      await run('apply-xmp', {
        xml: exportXmp({
          ...saved,
          edit: { postRepairFills: [{ ...saved.edit.postRepairFills[0], width: 0 }] }
        })
      })
    } catch {
      invalidRejected = true
    }
    const invalidPreserved = canonical((await photo()).edit) === canonical(saved.edit)
    // An unversioned legacy fill at the destination must remain below Clone.
    const rgba = new Uint8Array(9 * 9 * 4)
    for (let i = 0; i < rgba.length; i += 4) rgba.set([0, 0, 255, 255], i)
    const legacyFill = {
      x: 62 / width,
      y: 28 / height,
      w: 9 / width,
      h: 9 / height,
      width: 9,
      height: 9,
      rgba: btoa(String.fromCharCode(...deflateSync(rgba)))
    }
    const legacyEdit = {
      fills: [legacyFill],
      localTools: { repairs: [{ ...saved.edit.localTools.repairs[0], opacity: 1 }], masks: [] }
    }
    await run('apply-xmp', { xml: exportXmp({ ...saved, edit: legacyEdit }) })
    const legacyTarget = pixel(await render(), 66, 32)
    await run('apply-xmp', { xml })
    const original = new Uint8Array(await (await run('export', { format: 'original' })).blob.arrayBuffer())
    const input = new Uint8Array(await file.arrayBuffer())
    return {
      id,
      publicAnchorRejections,
      retainedAnchor,
      cases,
      versionEqual,
      xmpEqual,
      pasted,
      missingAnchorTarget,
      saved: saved.edit,
      savedPixels: Array.from(savedPixels),
      removalKeys,
      invalidRejected,
      invalidPreserved,
      legacyTarget,
      originalEqual: original.length === input.length && original.every((v, i) => v === input[i])
    }
  })
  for (const entry of result.cases) {
    assert.ok(entry.before[0] > 150, JSON.stringify(entry))
    assert.ok(
      entry.after.slice(0, 3).every((v) => Math.abs(v - 96) <= 6),
      JSON.stringify(entry)
    )
    assert.equal(entry.exteriorChanges, 0)
    assert.equal(entry.postCount, 1)
    assert.equal(entry.legacyCount, 0)
    assert.equal(entry.masks, 0)
    assert.deepEqual(entry.laterClone, [245, 29, 22, 255])
    assert.ok(entry.laterRemoval.slice(0, 3).every((v) => Math.abs(v - 96) <= 6))
    assert.equal(entry.anchored, true)
    assert.ok(entry.repairRetained && entry.undo && entry.redo)
  }
  assert.ok(
    result.versionEqual &&
      result.xmpEqual &&
      result.invalidRejected &&
      result.invalidPreserved &&
      result.originalEqual
  )
  assert.deepEqual(result.removalKeys, ['fills', 'postRepairFills'])
  assert.equal(result.publicAnchorRejections, 2)
  assert.equal(result.retainedAnchor, true)
  assert.deepEqual(result.pasted.postRepairFills, result.saved.postRepairFills)
  assert.deepEqual(result.legacyTarget, [245, 29, 22, 255])
  assert.deepEqual(result.missingAnchorTarget, [245, 29, 22, 255])
  await page.reload()
  await page.waitForFunction(() => window.openlr)
  const restored = await page.evaluate(async (id) => {
    const run = window.openlr.run
    await run('select', { id })
    const { blob } = await run('export', { format: 'image/png' })
    const bitmap = await createImageBitmap(blob),
      canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    return {
      edit: (await run('state')).photos.find((p) => p.id === id).edit,
      pixels: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data)
    }
  }, result.id)
  assert.deepEqual(restored.edit, result.saved)
  assert.deepEqual(restored.pixels, result.savedPixels)
})
