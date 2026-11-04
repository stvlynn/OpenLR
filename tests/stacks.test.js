import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('stacks, covers, smart albums, virtual originals and advancement agree across GUI and agent commands', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const run = (command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
  const { added } = await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 48
    const ctx = c.getContext('2d'),
      files = []
    for (const name of ['a', 'b', 'c']) {
      ctx.fillStyle = name === 'c' ? '#c03344' : '#3499ae'
      ctx.fillRect(0, 0, 64, 48)
      files.push(new File([await new Promise((cb) => c.toBlob(cb))], name + '.png', { type: 'image/png' }))
    }
    return window.openlr.run('import', { files })
  })
  await run('sort', { order: 'name' })
  await run('select-many', { ids: added.slice(0, 2) })
  await run('stack')
  let state = await run('state')
  assert.equal(state.photos.length, 2)
  await run('stack-toggle')
  await run('select', { id: added[1] })
  await run('stack-cover')
  await run('stack-toggle')
  assert.equal((await run('state')).selected, added[1])
  await run('unstack')
  assert.equal((await run('auto-stack', { by: 'similarity', threshold: 0.035 })).groups, 1)
  await run('select', { id: added[1] })
  await run('unstack')
  await run('select', { id: added[0] })
  await run('preferences', { autoAdvance: true })
  await run('rate', { value: 5 })
  assert.equal((await run('state')).selected, added[1])
  await run('filter', { rating: 5 })
  const album = await run('album', { name: 'Selects', smart: true })
  await run('filter', { rating: 0 })
  await run('scope', { id: album.id })
  assert.deepEqual(
    (await run('state')).photos.map((p) => p.id),
    [added[0]]
  )
  await run('virtual-copy')
  state = await run('state')
  const copy = state.photos.find((p) => p.virtual)
  assert.equal(copy.originalId, added[0])
  await run('edit', { key: 'Exposure', value: 1 })
  assert.deepEqual((await run('state')).photos.find((p) => p.id === added[0]).edit, {})
  assert.equal(
    await page.evaluate(async () => {
      const d = await import('./catalog.js')
      return (await d.all('originals')).length
    }),
    3
  )
  await run('scope', { id: 'all' })
  await run('select', { id: added[0] })
  await run('rename', { name: 'lake-original.png' })
  await run('library-undo')
  assert.equal((await run('state')).photos.find((p) => p.id === added[0]).name, 'a.png')
  await run('library-redo')
  assert.equal((await run('state')).photos.find((p) => p.id === added[0]).name, 'lake-original.png')
  await run('select', { id: added[0] })
  await run('delete')
  await run('scope', { id: 'trash' })
  await run('select', { id: added[0] })
  await run('purge')
  await run('scope', { id: 'all' })
  await run('select', { id: copy.id })
  assert.ok(
    await page.evaluate(async () => (await window.openlr.run('export', { format: 'original' })).blob.size > 0)
  )
})
