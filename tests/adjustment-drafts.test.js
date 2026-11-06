import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'

const data = new Uint8Array(48 * 32 * 3)
for (let i = 0; i < data.length; i += 3) data.set([64, 96, 128], i)
const original = Buffer.from(makePng({ width: 48, height: 32, bits: 8, colorType: 2, srgb: 0, data }))
const editOf = (state) => state.photos.find((photo) => photo.id === state.selected).edit

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  t.diagnostic('Chrome ' + browser.version())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  const run = (command, args = {}) =>
    page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args])
  await page.locator('#files').setInputFiles([
    { name: 'draft-a.png', mimeType: 'image/png', buffer: original },
    { name: 'draft-b.png', mimeType: 'image/png', buffer: original }
  ])
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)
  const state = await run('state')
  await run('select', { id: state.photos.find((p) => p.name === 'draft-a.png').id })
  await run('view', { mode: 'detail' })
  return { page, run }
}

async function ready(page, id) {
  return waitForAsyncFunction(
    page,
    async (id) => {
      const draft = (await window.openlr.run('state', { summary: true })).adjustmentDraft
      if (draft?.status === 'failed') throw Error(JSON.stringify(draft))
      return draft?.id === id && draft.status === 'ready' ? draft : false
    },
    id
  )
}

async function output(page, command = 'preview', args = {}) {
  return page.evaluate(
    async ([command, args]) => {
      const { blob } = await window.openlr.run(command, args)
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      return {
        width: canvas.width,
        height: canvas.height,
        pixels: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data)
      }
    },
    [command, args]
  )
}

async function stage(page) {
  return page
    .locator('#stage > canvas')
    .last()
    .evaluate((canvas) => ({
      width: canvas.width,
      height: canvas.height,
      pixels: Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)
    }))
}

test('adjustment draft returns actual displayed pixels without saving; cancel and commit preserve history', async (t) => {
  const { page, run } = await workspace(t)
  await run('edit', { key: 'Exposure', value: -1 })
  const saved = editOf(await run('state'))
  const baseline = await output(page)
  await run('compare')
  assert.equal(await page.locator('#compare').getAttribute('aria-pressed'), 'true')
  const draft = await run('edit', { key: 'Exposure', value: 1, draft: true })
  assert.equal(draft.photoId, (await run('state')).selected)
  await ready(page, draft.id)
  assert.equal((await run('state')).compare, false)
  assert.equal(await page.locator('#compare').getAttribute('aria-pressed'), 'false')
  assert.deepEqual(editOf(await run('state')), saved)
  assert.deepEqual(await output(page), baseline, 'default preview retains committed recipe')
  const image = await output(page, 'preview', { source: 'draft', draftId: draft.id })
  assert.deepEqual(image, await stage(page), 'draft PNG contains every displayed edited-pane pixel')
  assert.notDeepEqual(image.pixels.slice(0, 4), baseline.pixels.slice(0, 4))
  await run('draft-cancel', { id: draft.id })
  assert.equal((await run('state')).adjustmentDraft, null)
  assert.deepEqual(await output(page), baseline)
  await assert.rejects(run('draft-commit', { id: draft.id }))
  const first = await run('edit', { key: 'Exposure', value: 0.5, draft: true })
  const last = await run('edit', { key: 'Exposure', value: 1, draft: true })
  assert.notEqual(first.id, last.id)
  await ready(page, last.id)
  await assert.rejects(run('draft-cancel', { id: first.id }))
  await assert.rejects(run('preview', { source: 'draft', draftId: first.id }))
  await run('draft-commit', { id: last.id })
  assert.equal(editOf(await run('state')).Exposure, 1)
  assert.equal((await run('state')).adjustmentDraft, null)
  await run('undo')
  assert.deepEqual(editOf(await run('state')), saved, 'one undo restores pre-draft edit')
  await run('undo')
  assert.equal(editOf(await run('state')).Exposure ?? 0, 0, 'draft updates added no history')
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
    )
  )
  assert.deepEqual(Buffer.from(bytes), original)
})

test('curve and grading drafts share actual preview, cancellation and persisted commit in both processing modes', async (t) => {
  const { page, run } = await workspace(t)
  for (const version of [1, 2]) {
    await run('processing', { version })
    for (const [command, args] of [
      [
        'curve-set',
        {
          channel: 'red',
          points: [
            { x: 0, y: 0.2 },
            { x: 1, y: 1 }
          ]
        }
      ],
      ['grading-set', { value: { global: { hue: 40, saturation: 50, luminance: 20 } } }]
    ]) {
      const baseline = editOf(await run('state'))
      const oldPixel = (await output(page)).pixels.slice(0, 4)
      const draft = await run(command, { ...args, draft: true })
      await ready(page, draft.id)
      const image = await output(page, 'preview', { source: 'draft', draftId: draft.id })
      assert.deepEqual(image, await stage(page))
      assert.notDeepEqual(image.pixels.slice(0, 4), oldPixel)
      assert.deepEqual(editOf(await run('state')), baseline)
      await run('draft-commit', { id: draft.id })
      const committed = editOf(await run('state'))
      const photoId = (await run('state')).selected
      assert.notDeepEqual(committed, baseline)
      assert.deepEqual((await output(page)).pixels.slice(0, 4), image.pixels.slice(0, 4))
      await page.reload()
      await page.waitForFunction(() => window.openlr)
      await run('select', { id: photoId })
      assert.deepEqual(editOf(await run('state')), committed)
      await run('view', { mode: 'detail' })
      await run('reset')
    }
  }
})

test('trusted slider, curve and grading gestures expose the same draft state and image commands', async (t) => {
  const { page, run } = await workspace(t)
  const observe = async (command) => {
    const draft = await waitForAsyncFunction(
      page,
      async (command) => {
        const draft = (await window.openlr.run('state')).adjustmentDraft
        return draft?.command === command && draft.status === 'ready' ? draft : false
      },
      command
    )
    assert.deepEqual(await output(page, 'preview', { source: 'draft', draftId: draft.id }), await stage(page))
    assert.deepEqual(editOf(await run('state')), {})
    return draft
  }
  const slider = page.getByRole('slider', { name: 'Exposure', exact: true })
  await slider.scrollIntoViewIfNeeded()
  const sliderBox = await slider.boundingBox()
  await page.mouse.move(sliderBox.x + sliderBox.width * 0.7, sliderBox.y + sliderBox.height / 2)
  await page.mouse.down()
  const scalar = await observe('edit')
  await page.mouse.up()
  await waitForAsyncFunction(page, async () => (await window.openlr.run('state')).adjustmentDraft === null)
  assert.equal(editOf(await run('state')).Exposure, scalar.args.value)
  await run('undo')

  await run('panel', { name: 'Point curve', open: true })
  await page.locator('#curve-graph').scrollIntoViewIfNeeded()
  const curveBox = await page.locator('#curve-graph').boundingBox()
  await page.mouse.move(curveBox.x + curveBox.width * 0.5, curveBox.y + curveBox.height * 0.3)
  await page.mouse.down()
  await observe('curve-set')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await waitForAsyncFunction(page, async () => (await window.openlr.run('state')).adjustmentDraft === null)
  assert.deepEqual(editOf(await run('state')), {})

  await run('grading-mode', { mode: 'global' })
  await page.locator('#color-grading > summary').click()
  await page.locator('#grading-wheel-global').scrollIntoViewIfNeeded()
  const wheelBox = await page.locator('#grading-wheel-global').boundingBox()
  await page.mouse.move(wheelBox.x + wheelBox.width * 0.75, wheelBox.y + wheelBox.height * 0.5)
  await page.mouse.down()
  await observe('grading-set')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await waitForAsyncFunction(page, async () => (await window.openlr.run('state')).adjustmentDraft === null)
  assert.deepEqual(editOf(await run('state')), {})
})

test('draft identity, validation and selection prevent modifying a new asset or a newer committed recipe', async (t) => {
  const { page, run } = await workspace(t)
  const state = await run('state')
  await assert.rejects(run('edit', { key: 'Exposure', value: 1000, draft: true }))
  await assert.rejects(run('edit', { key: 'turn', value: 1, draft: true }))
  await assert.rejects(run('curve-set', { channel: 'red', points: [{ x: 0, y: 0 }], draft: true }))
  await assert.rejects(run('grading-set', { value: { global: { saturation: 101 } }, draft: true }))
  assert.equal((await run('state')).adjustmentDraft, null)
  const draft = await run('edit', { key: 'Exposure', value: 1, draft: true })
  await run('select', { id: state.photos.find((p) => p.id !== state.selected).id })
  assert.equal((await run('state')).adjustmentDraft, null)
  await assert.rejects(run('draft-commit', { id: draft.id }))
  assert.deepEqual(editOf(await run('state')), {})
  const next = await run('edit', { key: 'Exposure', value: 1, draft: true })
  await run('edit', { key: 'Contrast', value: 10 })
  await assert.rejects(run('draft-commit', { id: next.id }))
  assert.equal(editOf(await run('state')).Exposure, undefined)
  assert.equal(editOf(await run('state')).Contrast, 10)
})

test('CLI cancellation and replacement of held GUI gestures prevent later pointer release from saving', async (t) => {
  const { page, run } = await workspace(t)
  await run('panel', { name: 'Point curve', open: true })
  await run('panel', { name: 'Color grading', open: true })
  await run('grading-mode', { mode: 'global' })
  for (const action of ['cancel', 'replace'])
    for (const [command, selector, x, y] of [
      ['edit', 'input[data-control="Exposure"]', 0.7, 0.5],
      ['curve-set', '#curve-graph', 0.5, 0.3],
      ['grading-set', '#grading-wheel-global', 0.75, 0.5]
    ]) {
      const control = page.locator(selector)
      await control.scrollIntoViewIfNeeded()
      const box = await control.boundingBox()
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y)
      await page.mouse.down()
      const draft = await waitForAsyncFunction(
        page,
        async (command) => {
          const draft = (await window.openlr.run('state')).adjustmentDraft
          return draft?.command === command && draft.status === 'ready' ? draft : false
        },
        command
      )
      const replacement =
        action === 'replace' ? await run('edit', { key: 'Contrast', value: 25, draft: true }) : null
      if (!replacement) await run('draft-cancel', { id: draft.id })
      await page.mouse.up()
      if (replacement) {
        await ready(page, replacement.id)
        await run('draft-cancel', { id: replacement.id })
      }
      assert.equal((await run('state')).adjustmentDraft, null)
      assert.deepEqual(editOf(await run('state')), {}, `${command} must not save the canceled gesture`)
      await assert.rejects(run('draft-commit', { id: draft.id }))
    }
})

test('a failed draft save restores displayed and stored edits without adding history', async (t) => {
  const { page, run } = await workspace(t)
  await run('edit', { key: 'Exposure', value: -1 })
  const baseline = editOf(await run('state'))
  const baselineStage = await stage(page)
  const draft = await run('edit', { key: 'Exposure', value: 1, draft: true })
  await ready(page, draft.id)
  const failure = await page.evaluate(async (id) => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'photos') throw new DOMException('Draft save storage failure', 'QuotaExceededError')
      return put.apply(this, args)
    }
    try {
      await window.openlr.run('draft-commit', { id })
      return null
    } catch (error) {
      return error.message
    } finally {
      IDBObjectStore.prototype.put = put
    }
  }, draft.id)
  assert.match(failure, /Draft save storage failure/)
  assert.deepEqual(editOf(await run('state')), baseline)
  assert.equal((await run('state')).adjustmentDraft, null)
  assert.deepEqual(await stage(page), baselineStage)
  const stored = await page.evaluate(async () => {
    const state = await window.openlr.run('state')
    const db = await import('/catalog.js')
    return (await db.all('photos')).find((photo) => photo.id === state.selected).edit
  })
  assert.deepEqual(stored, baseline)
  await run('undo')
  assert.equal(editOf(await run('state')).Exposure ?? 0, 0)
})
