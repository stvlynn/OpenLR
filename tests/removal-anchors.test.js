import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'
import { validatePostRepairFills } from '../web/fill.js'
import { renderFrame } from '../web/render.js'

function patch(id, x, y, w, h, rgba) {
  return {
    id,
    x,
    y,
    w,
    h,
    width: 1,
    height: 1,
    rgba: deflateRawSync(Uint8Array.from(rgba)).toString('base64')
  }
}

test('new fills require unique IDs and composite without quantizing exterior float samples', () => {
  const fill = patch('fill-a', 0.25, 0, 0.25, 1, [255, 0, 0, 128]),
    input = {
      width: 4,
      height: 1,
      colorSpace: 'srgb-linear',
      data: Float32Array.from([
        -0.25, 3.5, 0.201, 1, 0.125, 0.25, 0.5, 0.5, 2, -0.5, 0.202, 0.5, 4, -2, 0.203, 1
      ])
    },
    original = input.data.slice()
  assert.throws(() => validatePostRepairFills([fill, { ...fill }]), /unique IDs/)
  assert.throws(() => validatePostRepairFills([{ ...fill, id: undefined }]), /unique IDs/)
  assert.throws(() => validatePostRepairFills([{ ...fill, id: 42 }]), /unique IDs/)
  const result = renderFrame(input, { postRepairFills: [fill] }),
    patchAlpha = Math.fround(128 / 255),
    uncoveredAlpha = 0.5 * (1 - patchAlpha),
    outputAlpha = patchAlpha + uncoveredAlpha
  assert.notEqual(result.data.buffer, input.data.buffer)
  assert.deepEqual(input.data, original)
  assert.deepEqual(result.data.slice(0, 4), original.slice(0, 4))
  assert.deepEqual(result.data.slice(8), original.slice(8))
  assert.deepEqual(
    result.data.slice(4, 8),
    Float32Array.of(
      (patchAlpha + 0.125 * uncoveredAlpha) / outputAlpha,
      (0.25 * uncoveredAlpha) / outputAlpha,
      (0.5 * uncoveredAlpha) / outputAlpha,
      outputAlpha
    )
  )
})

test('an orphaned repair keeps its visible position when another fill is appended', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const width = 32,
    height = 16,
    x = 24,
    y = 8,
    data = new Uint8Array(width * height * 3).fill(96)
  for (let sy = 6; sy <= 8; sy++)
    for (let sx = 6; sx <= 8; sx++) data.set([245, 29, 22], (sy * width + sx) * 3)
  const target = { x: (x + 0.5) / width, y: (y + 0.5) / height },
    fill = patch('other-fill', x / width, y / height, 1 / width, 1 / height, [96, 96, 96, 255]),
    edit = {
      postRepairFills: [fill],
      localTools: {
        repairs: [
          {
            id: 'pasted-repair',
            type: 'clone',
            source: { x: 7.5 / width, y: 7.5 / height },
            points: [target],
            radius: 0.1,
            feather: 0,
            afterFillId: 'missing-fill'
          }
        ]
      }
    }
  await page.locator('#files').setInputFiles({
    name: 'orphan-repair.png',
    mimeType: 'image/png',
    buffer: Buffer.from(makePng({ width, height, bits: 8, data }))
  })
  await page.locator('#gallery .tile').waitFor()
  const result = await page.evaluate(
    async ({ x, y, target, edit }) => {
      const run = window.openlr.run,
        { exportXmp } = await import('./xmp.js')
      const renderedPixel = async () => {
        const { blob } = await run('export', { format: 'image/png' }),
          bitmap = await createImageBitmap(blob),
          canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d')
        context.drawImage(bitmap, 0, 0)
        bitmap.close()
        return Array.from(context.getImageData(x, y, 1, 1).data)
      }
      await run('view', { mode: 'detail' })
      await run('apply-xmp', { xml: exportXmp({ ...(await run('state')).photos[0], edit }) })
      const before = await renderedPixel()
      await run('mask.add', {
        mask: { type: 'radial', center: target, rx: 0.125, ry: 0.25, feather: 0 }
      })
      const state = await run('remove-mask', { algorithm: 'ns' }),
        after = await renderedPixel()
      await run('undo')
      const undone = await renderedPixel()
      return { before, after, undone, edit: state.photos[0].edit }
    },
    { x, y, target, edit }
  )
  assert.deepEqual(result.before, [245, 29, 22, 255])
  assert.deepEqual(result.undone, result.before)
  assert.deepEqual(result.after, [96, 96, 96, 255])
  assert.equal(result.edit.localTools.repairs[0].afterFillId, fill.id)
  assert.deepEqual(result.edit.postRepairFills[0], fill)
  assert.equal(result.edit.postRepairFills.length, 2)
  assert.notEqual(result.edit.postRepairFills[1].id, fill.id)
})
