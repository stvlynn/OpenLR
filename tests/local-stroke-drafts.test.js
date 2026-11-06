import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'

const width = 100,
  height = 80
const data = new Uint8Array(width * height * 3)
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) data.set(x < 40 ? [180, 60, 30] : [40, 90, 150], (y * width + x) * 3)
const original = Buffer.from(makePng({ width, height, bits: 8, colorType: 2, srgb: 0, data }))
const base = { opacity: 1, feather: 0.2 }
const candidates = [
  {
    ...base,
    type: 'brush',
    points: [
      { x: 0.6, y: 0.45 },
      { x: 0.75, y: 0.55 }
    ],
    radius: 0.1
  },
  { ...base, type: 'linear', start: { x: 0.2, y: 0.5 }, end: { x: 0.8, y: 0.5 } },
  { ...base, type: 'radial', center: { x: 0.6, y: 0.5 }, rx: 0.2, ry: 0.25 },
  ...['clone', 'heal'].map((type) => ({
    ...base,
    type,
    points: [
      { x: 0.6, y: 0.45 },
      { x: 0.75, y: 0.55 }
    ],
    radius: 0.1,
    source: { x: 0.2, y: 0.3 }
  }))
]
const editOf = (state) => state.photos.find((photo) => photo.id === state.selected).edit
const change = (tool) =>
  ['clone', 'heal'].includes(tool.type)
    ? ['repair.add', { repair: tool }]
    : ['mask.add', { mask: { ...tool, adjustments: { Exposure: 1 } } }]

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  t.diagnostic('Chrome ' + browser.version())
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page
    .locator('#files')
    .setInputFiles({ name: 'local-draft.png', mimeType: 'image/png', buffer: original })
  await page.waitForFunction(() => document.querySelector('#gallery .tile'))
  const run = (command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
  await run('local-tool', { tool: 'brush' })
  return { page, run }
}
async function image(page, command = 'preview', args = {}) {
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

test('all five local stroke drafts expose visible overlay pixels without saving; commit uses one history entry', async (t) => {
  const { page, run } = await workspace(t)
  const before = editOf(await run('state'))
  const baseline = await image(page)
  for (const tool of candidates) {
    await run('local-tool', { tool: tool.type })
    const [command, args] = change(tool)
    const staged = await run(command, { ...args, draft: true })
    assert.equal(staged.command, command)
    assert.equal(staged.status, 'ready')
    assert.equal(staged.visible, true)
    assert.deepEqual((await run('state')).localDraft, staged)
    assert.deepEqual((await run('state', { summary: true })).localDraft, staged)
    assert.deepEqual(editOf(await run('state')), before)
    assert.deepEqual(await image(page), baseline)
    const overlay = await image(page, 'preview', { source: 'local-draft', draftId: staged.id })
    const bounds = await page.locator('.local-overlay').boundingBox()
    assert.equal(overlay.width, Math.max(1, Math.round(bounds.width)))
    assert.equal(overlay.height, Math.max(1, Math.round(bounds.height)))
    const alpha = overlay.pixels.filter((_, i) => i % 4 === 3)
    assert.ok(
      alpha.some((value) => value > 0),
      tool.type + ' contains actual stroke pixels'
    )
    assert.ok(
      alpha.some((value) => value === 0),
      tool.type + ' preserves transparent exterior'
    )
    await run('draft-cancel', { id: staged.id })
    assert.equal((await run('state')).localDraft, null)
    await assert.rejects(run('draft-commit', { id: staged.id }))
    assert.deepEqual(await image(page), baseline)
    const next = await run(command, { ...args, draft: true })
    await run('draft-commit', { id: next.id })
    const committed = editOf(await run('state'))
    const key = command === 'mask.add' ? 'masks' : 'repairs'
    assert.equal(committed.localTools[key].length, 1)
    assert.equal(committed.localTools[key][0].type, tool.type)
    assert.equal((await run('state')).localDraft, null)
    if (tool.type !== 'heal') assert.notDeepEqual(await image(page), baseline)
    await run('undo')
    assert.deepEqual(editOf(await run('state')), before)
    assert.deepEqual(await image(page), baseline)
  }
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await window.openlr.run('export', { format: 'original' })).blob.arrayBuffer())
    )
  )
  assert.deepEqual(Buffer.from(bytes), original)
})

test('local draft visibility, invalid geometry, stale identity and ordinary exports retain their independent contracts', async (t) => {
  const { page, run } = await workspace(t)
  const [command, args] = change(candidates[0])
  const baseline = await image(page)
  await assert.rejects(run(command, { mask: { ...args.mask, radius: -1 }, draft: true }))
  assert.equal((await run('state')).localDraft, null)
  const old = await run(command, { ...args, draft: true })
  const current = await run(command, { ...change({ ...candidates[0], radius: 0.2 })[1], draft: true })
  await assert.rejects(run('draft-cancel', { id: old.id }))
  await assert.rejects(run('preview', { source: 'local-draft', draftId: old.id }))
  assert.equal((await run('state')).localDraft.id, current.id)
  await run('mask-overlay', { enabled: false })
  const hidden = (await run('state')).localDraft
  assert.equal(hidden.id, current.id)
  assert.equal(hidden.visible, false)
  const transparent = await image(page, 'preview', { source: 'local-draft', draftId: current.id })
  assert.ok(transparent.pixels.filter((_, i) => i % 4 === 3).every((alpha) => alpha === 0))
  assert.deepEqual(await image(page), baseline)
  await run('local-cancel')
  assert.equal((await run('state')).localDraft, null)
  await assert.rejects(run('draft-commit', { id: current.id }))
})

test('a trusted local brush stroke can be inspected and canceled through the CLI before pointer release', async (t) => {
  const { page, run } = await workspace(t)
  const box = await page.locator('#stage canvas').boundingBox()
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.45)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.55, { steps: 3 })
  const staged = await waitForAsyncFunction(page, async () => (await window.openlr.run('state')).localDraft)
  assert.equal(staged.command, 'mask.add')
  assert.deepEqual(editOf(await run('state')), {})
  const overlay = await image(page, 'preview', { source: 'local-draft', draftId: staged.id })
  assert.ok(overlay.pixels.some((value, i) => i % 4 === 3 && value > 0))
  await run('draft-cancel', { id: staged.id })
  await page.mouse.up()
  assert.equal((await run('state')).localDraft, null)
  assert.deepEqual(editOf(await run('state')), {})
})
