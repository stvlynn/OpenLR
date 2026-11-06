import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'
import { makePng } from './fixtures/png.mjs'

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  const run = (command, args = {}) =>
    page.evaluate(([name, params]) => window.openlr.run(name, params), [command, args])
  const width = 96,
    height = 64
  const inputs = [32, 128].map((red, index) => {
    const pixels = new Uint8Array(width * height * 3)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) pixels.set([red + (x % 32), 80 + y, 168], (y * width + x) * 3)
    return {
      name: `draft-race-${index}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(makePng({ width, height, bits: 8, colorType: 2, srgb: 0, data: pixels }))
    }
  })
  await page.locator('#files').setInputFiles(inputs)
  await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)
  const { photos } = await run('state')
  const ids = inputs.map(({ name }) => photos.find((photo) => photo.name === name).id)
  await run('select', { id: ids[0] })
  await run('view', { mode: 'detail' })
  const stage = () =>
    page
      .locator('#stage > canvas')
      .last()
      .evaluate((canvas) => canvas.toDataURL())
  return { page, run, stage, ids }
}

async function holdAnalysisResults(page) {
  await page.evaluate(() => {
    const Worker = window.Worker
    window.analysisResults = []
    window.Worker = class extends Worker {
      constructor(url, options) {
        super(url, options)
        this.analysis = url.pathname?.endsWith('/dehaze-worker.js')
      }
      set onmessage(listener) {
        super.onmessage = (event) => {
          if (!this.analysis || event.data.ready) return listener(event)
          const result = {
            terminated: false,
            release: (message) => listener(message ? { data: { code: 'FIXTURE', message } } : event)
          }
          this.heldResult = result
          window.analysisResults.push(result)
        }
      }
      terminate() {
        if (this.heldResult) this.heldResult.terminated = true
        super.terminate()
      }
    }
    window.draftChanges = []
    window.addEventListener('openlr-change', () => {
      window.openlr.run('state', { summary: true }).then((state) => {
        window.draftChanges.push(state.adjustmentDraft)
      })
    })
  })
}

const scalar = (key, value) => ({ key, value, draft: true })
const draftState = async (run) => (await run('state', { summary: true })).adjustmentDraft
const workerHeld = (page, index) =>
  page.waitForFunction((index) => Boolean(window.analysisResults[index]), index)
const releaseWorker = (page, index, message) =>
  page.evaluate(([index, message]) => window.analysisResults[index].release(message), [index, message])
const waitForDraftChange = (page, id, status) =>
  page.waitForFunction(
    ([id, status]) => window.draftChanges.some((draft) => draft?.id === id && draft.status === status),
    [id, status]
  )

test(
  'real delayed draft renders can be superseded or canceled before publication',
  { timeout: 45_000 },
  async (t) => {
    const { page, run, stage, ids } = await workspace(t)
    const baseline = await stage()
    await holdAnalysisResults(page)
    const old = await run('edit', scalar('Dehaze', 50))
    assert.equal(old.status, 'pending')
    await workerHeld(page, 0)
    await waitForDraftChange(page, old.id, 'pending')
    assert.equal(await stage(), baseline)
    await assert.rejects(run('preview', { source: 'draft', draftId: old.id }), /not ready/i)

    const newer = await run('edit', scalar('Exposure', 1))
    await waitForDraftChange(page, newer.id, 'ready')
    const newestPixels = await stage()
    assert.notEqual(newestPixels, baseline)
    assert.equal(await page.evaluate(() => window.analysisResults[0].terminated), true)
    // Deliver an already-produced result after termination to model a late event.
    await releaseWorker(page, 0)
    await assert.rejects(run('draft-commit', { id: old.id }), /draft changed/i)
    assert.equal((await draftState(run)).id, newer.id)
    assert.equal(await stage(), newestPixels)

    const canceled = await run('edit', scalar('Dehaze', 60))
    await workerHeld(page, 1)
    await run('draft-cancel', { id: canceled.id })
    assert.equal(await draftState(run), null)
    assert.equal(await stage(), baseline)
    assert.equal(await page.evaluate(() => window.analysisResults[1].terminated), true)
    await releaseWorker(page, 1)
    assert.equal(await draftState(run), null)
    assert.equal(await stage(), baseline)

    const left = await run('edit', scalar('Dehaze', 70))
    await workerHeld(page, 2)
    await run('select', { id: ids[1] })
    const nextPhotoPixels = await stage()
    assert.notEqual(nextPhotoPixels, baseline)
    assert.equal(await page.evaluate(() => window.analysisResults[2].terminated), true)
    await releaseWorker(page, 2)
    assert.equal(await draftState(run), null)
    assert.equal(await stage(), nextPhotoPixels)
    const state = await run('state')
    assert.equal(state.selected, ids[1])
    assert.ok(state.photos.every((photo) => !photo.edit.Dehaze && !photo.edit.Exposure))
    const announced = await page.evaluate(() => window.draftChanges)
    for (const { id } of [old, canceled, left])
      assert.ok(!announced.some((draft) => draft?.id === id && draft.status !== 'pending'))
  }
)

test(
  'failed draft publishes an error notification, retains the canvas and can be retried',
  { timeout: 45_000 },
  async (t) => {
    const { page, run, stage } = await workspace(t)
    const baseline = await stage()
    await holdAnalysisResults(page)
    const failed = await run('edit', scalar('Dehaze', 80))
    await workerHeld(page, 0)
    await waitForDraftChange(page, failed.id, 'pending')
    const message = 'Injected Dehaze completion failure'
    await releaseWorker(page, 0, message)
    await waitForDraftChange(page, failed.id, 'failed')
    assert.equal((await draftState(run)).error, message)
    assert.equal(await stage(), baseline)
    await assert.rejects(
      run('preview', { source: 'draft', draftId: failed.id }),
      /Injected Dehaze completion failure/
    )

    const retry = await run('edit', scalar('Dehaze', 80))
    assert.notEqual(retry.id, failed.id)
    await workerHeld(page, 1)
    await waitForDraftChange(page, retry.id, 'pending')
    await releaseWorker(page, 1)
    await waitForDraftChange(page, retry.id, 'ready')
    assert.notEqual(await stage(), baseline)
    assert.equal(
      (await run('state')).photos.find((photo) => photo.id === retry.photoId).edit.Dehaze,
      undefined
    )
  }
)

test(
  'draft PNG encoding releases the mutation queue and rejects superseded canvas ownership',
  { timeout: 45_000 },
  async (t) => {
    const { page, run, stage } = await workspace(t)
    const first = await run('edit', scalar('Exposure', 1))
    const waitReady = (id) =>
      waitForAsyncFunction(
        page,
        async (id) => {
          const draft = (await window.openlr.run('state', { summary: true })).adjustmentDraft
          return draft?.id === id && draft.status === 'ready'
        },
        id
      )
    await waitReady(first.id)
    const firstPixels = await stage()
    await page.evaluate((draftId) => {
      const original = HTMLCanvasElement.prototype.toBlob
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        if (this.parentElement !== document.getElementById('stage') || type !== 'image/png')
          return original.call(this, callback, type, quality)
        HTMLCanvasElement.prototype.toBlob = original
        return original.call(
          this,
          (blob) => {
            window.heldDraftPng = { bytes: blob?.size ?? 0, release: () => callback(blob) }
          },
          type,
          quality
        )
      }
      window.oldDraftRead = window.openlr.dispatch('preview', {
        source: 'draft',
        draftId
      })
    }, first.id)
    await page.waitForFunction(() => window.heldDraftPng?.bytes > 0)
    const newer = await run('edit', scalar('Exposure', -1))
    await waitReady(newer.id)
    const newerPixels = await stage()
    assert.notEqual(newerPixels, firstPixels)
    const reply = await page.evaluate(async () => {
      window.heldDraftPng.release()
      return window.oldDraftRead
    })
    assert.equal(reply.ok, false)
    assert.match(reply.error.message, /draft changed/i)
    assert.equal((await draftState(run)).id, newer.id)
    assert.equal(await stage(), newerPixels)
  }
)

test(
  'queued CLI cancellation or replacement wins over a later GUI pointer release',
  { timeout: 45_000 },
  async (t) => {
    const { page, run } = await workspace(t)
    await run('panel', { name: 'Point curve', open: true })
    await run('panel', { name: 'Color grading', open: true })
    await run('grading-mode', { mode: 'global' })
    const original = (await run('state')).photos[0].edit
    for (const action of ['cancel', 'replace']) {
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
            const draft = (await window.openlr.run('state', { summary: true })).adjustmentDraft
            return draft?.command === command && draft.status === 'ready' ? draft : false
          },
          command
        )

        // Hold an ordinary queued observer, just as workspace capture awaits
        // the host. Both following commands must queue in their call order.
        await page.evaluate(() => {
          window.releaseDraftQueue = null
          window.openlr.run(
            'state',
            {},
            () =>
              new Promise((resolve) => {
                window.releaseDraftQueue = resolve
              })
          )
        })
        await page.waitForFunction(() => typeof window.releaseDraftQueue === 'function')
        await page.evaluate(
          ([action, id]) => {
            window.queuedDraftCommand =
              action === 'cancel'
                ? window.openlr.dispatch('draft-cancel', { id })
                : window.openlr.dispatch('edit', { key: 'Contrast', value: 25, draft: true })
          },
          [action, draft.id]
        )
        await page.mouse.up()
        const { reply, state } = await page.evaluate(async () => {
          window.releaseDraftQueue()
          const reply = await window.queuedDraftCommand
          return { reply, state: await window.openlr.run('state') }
        })
        const scenario = `${action} before ${command} pointer release`
        assert.equal(reply.ok, true, scenario)
        assert.deepEqual(state.photos.find((photo) => photo.id === state.selected).edit, original, scenario)
        await assert.rejects(run('draft-commit', { id: draft.id }), /draft changed/i)
        if (action === 'cancel') {
          assert.equal(reply.result.canceled, true, scenario)
          assert.equal(state.adjustmentDraft, null, scenario)
        } else {
          assert.equal(state.adjustmentDraft?.id, reply.result.id, scenario)
          await run('draft-cancel', { id: reply.result.id })
        }
      }
    }
  }
)
