import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'
import { readPng } from '../web/png.js'

const strokeTypes = ['brush', 'linear', 'radial', 'clone', 'heal']
const isRepair = (type) => type === 'clone' || type === 'heal'
const editOf = (state, id = state.selected) => state.photos.find((photo) => photo.id === id).edit

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.goto(server.url)
  const run = (command, args = {}) =>
    page.evaluate(([command, args]) => window.openlr.run(command, args), [command, args])
  const width = 144,
    height = 96
  const files = [60, 130].map((red, index) => {
    const data = new Uint8Array(width * height * 3)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) data.set([red + (x % 24), 70 + y, 120], (y * width + x) * 3)
    return {
      name: `stroke-race-${index}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(makePng({ width, height, bits: 8, colorType: 2, srgb: 0, data }))
    }
  })
  await page.locator('#files').setInputFiles(files)
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)
  const { photos } = await run('state')
  const ids = files.map(({ name }) => photos.find((photo) => photo.name === name).id)
  await run('select', { id: ids[0] })
  await run('view', { mode: 'detail' })
  const heldStroke = async (tool) => {
    await run('local-tool', { tool })
    if (isRepair(tool)) await run('repair-source', { point: { x: 0.18, y: 0.22 } })
    const bounds = await page.locator('#stage > canvas').boundingBox()
    await page.mouse.move(bounds.x + bounds.width * 0.33, bounds.y + bounds.height * 0.39)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width * 0.66, bounds.y + bounds.height * 0.59, { steps: 3 })
    return waitForAsyncFunction(
      page,
      async (tool) => {
        const { localDraft } = await window.openlr.run('state', { summary: true })
        const geometry = localDraft?.args?.mask ?? localDraft?.args?.repair
        return localDraft?.status === 'ready' && localDraft.visible && geometry?.type === tool
          ? localDraft
          : false
      },
      tool
    )
  }
  return { page, run, ids, heldStroke }
}

async function holdQueue(page) {
  // An ordinary command can retain the queue while its observer awaits the
  // host. Hold the real dispatcher there to control FIFO order.
  await page.evaluate(() => {
    window.releaseStrokeQueue = null
    window.openlr.run(
      'state',
      {},
      () =>
        new Promise((resolve) => {
          window.releaseStrokeQueue = resolve
        })
    )
  })
  await page.waitForFunction(() => typeof window.releaseStrokeQueue === 'function')
}

function queueCommand(page, command, args) {
  return page.evaluate(
    ([command, args]) => {
      window.queuedStrokeCommand = window.openlr.dispatch(command, args)
    },
    [command, args]
  )
}

function releaseQueue(page) {
  return page.evaluate(async () => {
    window.releaseStrokeQueue()
    const reply = await window.queuedStrokeCommand
    return { reply, state: await window.openlr.run('state') }
  })
}

async function overlayPng(page, id) {
  const reply = await page.evaluate(
    (id) => window.openlr.dispatch('preview', { source: 'local-draft', draftId: id }),
    id
  )
  assert.equal(reply.ok, true, reply.error?.message)
  assert.equal(reply.result.mimeType, 'image/png')
  const { width, height, data } = readPng(Buffer.from(reply.result.base64, 'base64'))
  return { width, height, data }
}

test(
  'local stroke queue gives cancel, replacement and pointer release their FIFO order',
  { timeout: 60_000 },
  async (t) => {
    const {
      page,
      run,
      ids: [id],
      heldStroke
    } = await workspace(t)
    await run('edit', { key: 'crop', value: { x: 0.07, y: 0.08, w: 0.82, h: 0.82 } })
    await run('rotate', { direction: 'right' })
    await run('flip')
    const beforeSentinel = editOf(await run('state'))
    await run('edit', { key: 'Exposure', value: -0.5 })
    const baseline = editOf(await run('state'))
    for (const tool of strokeTypes) {
      const canceled = await heldStroke(tool)
      await holdQueue(page)
      await queueCommand(page, 'local-cancel', { photoId: id })
      await page.mouse.up()
      const discarded = await releaseQueue(page)
      assert.deepEqual(discarded.reply, { ok: true, result: { canceled: true } }, tool)
      assert.equal(discarded.state.localDraft, null, tool)
      assert.deepEqual(editOf(discarded.state), baseline, tool)
      await assert.rejects(run('draft-commit', { id: canceled.id }), /draft changed/i)

      const old = await heldStroke(tool)
      const originalOverlay = await overlayPng(page, old.id)
      assert.ok(
        originalOverlay.data.some((v, i) => i % 4 === 3 && v > 0),
        tool
      )
      assert.ok(
        originalOverlay.data.some((v, i) => i % 4 === 3 && v === 0),
        tool
      )
      await holdQueue(page)
      await queueCommand(page, old.command, { ...old.args, draft: true })
      await page.mouse.up()
      const replaced = await releaseQueue(page)
      assert.equal(replaced.reply.ok, true, replaced.reply.error?.message)
      const current = replaced.state.localDraft
      assert.equal(current?.id, replaced.reply.result.id, tool)
      assert.notEqual(current?.id, old.id, tool)
      assert.deepEqual(editOf(replaced.state), baseline, tool)
      assert.deepEqual(await overlayPng(page, current.id), originalOverlay, tool + ' exact GUI/CLI overlay')
      await assert.rejects(run('draft-cancel', { id: old.id }), /draft changed/i)
      await run('draft-cancel', { id: current.id })

      await heldStroke(tool)
      await holdQueue(page)
      await page.mouse.up()
      await queueCommand(page, 'local-cancel', { photoId: id })
      const committed = await releaseQueue(page)
      assert.deepEqual(committed.reply, { ok: true, result: { canceled: false } }, tool)
      assert.equal(committed.state.localDraft, null, tool)
      const { masks, repairs } = editOf(committed.state).localTools
      assert.deepEqual(
        masks.map((item) => item.type),
        isRepair(tool) ? [] : [tool]
      )
      assert.deepEqual(
        repairs.map((item) => item.type),
        isRepair(tool) ? [tool] : []
      )
      await run('undo')
      assert.deepEqual(editOf(await run('state')), baseline, tool + ' one undo')
    }
    await run('undo')
    assert.deepEqual(
      editOf(await run('state')),
      beforeSentinel,
      'cancellation and replacement add no history'
    )
  }
)

test(
  'queued same-photo edit and selection change invalidate a released local stroke',
  { timeout: 45_000 },
  async (t) => {
    const {
      page,
      run,
      ids: [first, second],
      heldStroke
    } = await workspace(t)
    const before = await run('state')
    const brush = await heldStroke('brush')
    await holdQueue(page)
    await queueCommand(page, 'edit', { key: 'Contrast', value: 12, photoId: first })
    await page.mouse.up()
    const edited = await releaseQueue(page)
    assert.equal(edited.reply.ok, true)
    assert.equal(edited.state.localDraft, null)
    assert.deepEqual(editOf(edited.state, first), { ...editOf(before, first), Contrast: 12 })
    await assert.rejects(run('preview', { source: 'local-draft', draftId: brush.id }), /draft changed/i)

    const clone = await heldStroke('clone')
    await holdQueue(page)
    await queueCommand(page, 'select', { id: second })
    await page.mouse.up()
    const selected = await releaseQueue(page)
    assert.equal(selected.reply.ok, true)
    assert.equal(selected.state.selected, second)
    assert.equal(selected.state.localDraft, null)
    assert.deepEqual(editOf(selected.state, first), editOf(edited.state, first))
    assert.deepEqual(editOf(selected.state, second), editOf(before, second))
    await assert.rejects(run('draft-commit', { id: clone.id }), /draft changed/i)
  }
)
