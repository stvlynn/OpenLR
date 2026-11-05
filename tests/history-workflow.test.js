import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { waitForAsyncFunction } from './browser-wait.mjs'

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(10000)
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.openlr.run(command, args), { command, args })
  const imported = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 24
    canvas.height = 16
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#537b91'
    ctx.fillRect(0, 0, 24, 16)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve))
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
    const result = await window.openlr.run('import', {
      files: ['source.png', 'first.png', 'second.png'].map(
        (name) => new File([blob], name, { type: 'image/png' })
      )
    })
    return { ids: result.added, bytes }
  })
  assert.equal(imported.ids.length, 3)
  const row = async (id) => (await invoke('state')).photos.find((photo) => photo.id === id)
  const shortcut = async (redo = false) => {
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press(redo ? 'Control+Shift+z' : 'Control+z')
  }
  const waitRow = (id, fields) =>
    waitForAsyncFunction(
      page,
      async ({ id, fields }) => {
        const photo = (await window.openlr.run('state')).photos.find((item) => item.id === id)
        return Object.entries(fields).every(([key, value]) =>
          key === 'Exposure' ? (photo.edit.Exposure ?? null) === value : photo[key] === value
        )
      },
      { id, fields }
    )
  const assertOriginals = async () => {
    for (const id of imported.ids) {
      await invoke('select', { id })
      const bytes = await page.evaluate(async () => {
        const { blob } = await window.openlr.run('export', { format: 'original' })
        return Array.from(new Uint8Array(await blob.arrayBuffer()))
      })
      assert.deepEqual(bytes, imported.bytes)
    }
  }
  return { page, invoke, row, shortcut, waitRow, assertOriginals, ids: imported.ids }
}

test('Grid Ctrl+Z undoes pasted edits before earlier rating and replays interleaved histories in order', async (t) => {
  const {
    invoke,
    row,
    shortcut,
    waitRow,
    assertOriginals,
    ids: [source, target]
  } = await workspace(t)
  await invoke('select', { id: source })
  await invoke('edit', { key: 'Exposure', value: 1 })
  await invoke('copy-edits')
  await invoke('select', { id: target })
  await invoke('view', { mode: 'grid' })
  await invoke('rate', { value: 4, advance: false })
  await invoke('paste-edits')
  await shortcut()
  await waitRow(target, { Exposure: null, rating: 4 })
  assert.equal((await row(target)).edit.Exposure, undefined)
  assert.equal((await row(target)).rating, 4)
  await shortcut(true)
  await waitRow(target, { Exposure: 1, rating: 4 })
  assert.equal((await row(target)).edit.Exposure, 1)
  assert.equal((await row(target)).rating, 4)

  await invoke('flag', { value: 'pick', advance: false })
  await invoke('history-undo')
  assert.equal((await row(target)).flag, '')
  assert.equal((await row(target)).edit.Exposure, 1)
  await invoke('history-undo')
  assert.equal((await row(target)).edit.Exposure, undefined)
  assert.equal((await row(target)).rating, 4)
  await invoke('history-undo')
  assert.equal((await row(target)).rating, 0)
  await invoke('history-redo')
  assert.equal((await row(target)).rating, 4)
  assert.equal((await row(target)).edit.Exposure, undefined)
  await invoke('history-redo')
  assert.equal((await row(target)).edit.Exposure, 1)
  assert.equal((await row(target)).flag, '')
  await invoke('history-redo')
  assert.equal((await row(target)).flag, 'pick')
  await assertOriginals()
})

test('shared history targets the active photo, Detail skips library changes, and explicit histories stay separate', async (t) => {
  const {
    invoke,
    row,
    assertOriginals,
    ids: [first, second]
  } = await workspace(t)
  await invoke('select', { id: first })
  await invoke('edit', { key: 'Exposure', value: 1 })
  await invoke('select', { id: second })
  await invoke('edit', { key: 'Contrast', value: 20 })
  await invoke('select', { id: first })
  await invoke('view', { mode: 'grid' })
  await invoke('history-undo')
  assert.equal((await row(first)).edit.Exposure, undefined)
  assert.equal((await row(second)).edit.Contrast, 20)
  await invoke('history-redo')
  assert.equal((await row(first)).edit.Exposure, 1)

  await invoke('rate', { value: 4, advance: false })
  await invoke('view', { mode: 'detail' })
  await assert.rejects(invoke('edit', { key: 'Exposure', value: 1000 }), /range|between|Exposure/i)
  await invoke('history-undo')
  assert.equal((await row(first)).edit.Exposure, undefined)
  assert.equal((await row(first)).rating, 4)
  await invoke('history-redo')
  assert.equal((await row(first)).edit.Exposure, 1)
  await invoke('library-undo')
  assert.equal((await row(first)).rating, 0)
  assert.equal((await row(first)).edit.Exposure, 1)
  await invoke('undo')
  assert.equal((await row(first)).edit.Exposure, undefined)
  await invoke('library-redo')
  assert.equal((await row(first)).rating, 4)
  assert.equal((await row(first)).edit.Exposure, undefined)
  await invoke('redo')
  assert.equal((await row(first)).edit.Exposure, 1)
  assert.equal((await row(second)).edit.Contrast, 20)
  await assertOriginals()
})

test('batch paste history remains per photo and failed catalog commands create no history entry', async (t) => {
  const {
    invoke,
    row,
    shortcut,
    waitRow,
    assertOriginals,
    ids: [source, first, second]
  } = await workspace(t)
  await invoke('select', { id: source })
  await invoke('edit', { key: 'Exposure', value: 0.75 })
  await invoke('copy-edits')
  await invoke('select-many', { ids: [first, second] })
  await invoke('view', { mode: 'grid' })
  await invoke('rate', { value: 3, advance: false })
  await invoke('paste-edits')
  assert.equal((await invoke('state')).selected, first)
  await assert.rejects(invoke('rate', { value: 6 }), /range|between/i)
  await shortcut()
  await waitRow(first, { Exposure: null, rating: 3 })
  assert.equal((await row(first)).edit.Exposure, undefined)
  assert.equal((await row(first)).rating, 3)
  assert.equal((await row(second)).edit.Exposure, 0.75)
  assert.equal((await row(second)).rating, 3)
  await invoke('select', { id: second })
  await invoke('history-undo')
  assert.equal((await row(second)).edit.Exposure, undefined)
  assert.equal((await row(first)).rating, 3)
  await invoke('history-redo')
  assert.equal((await row(second)).edit.Exposure, 0.75)
  assert.equal((await row(first)).edit.Exposure, undefined)
  await assertOriginals()
})
