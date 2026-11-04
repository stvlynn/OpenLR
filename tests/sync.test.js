import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('two device libraries converge and concurrent edits require a choice before replacing either', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const objects = new Map()
  let serial = 0
  async function device() {
    const context = await browser.newContext(),
      page = await context.newPage()
    await page.exposeFunction('bridge', async (method, ...args) => {
      if (method === 'Local.Folders') return []
      if (method === 'Remote.Connect' || method === 'Remote.Disconnect') return null
      const [key, etag, data] = args,
        stored = objects.get(key)
      if (method === 'Remote.Get') return stored ? { ...stored, status: 200 } : { status: 404 }
      if (method === 'Remote.Put') {
        if (etag === '*' ? stored : stored?.etag !== etag) return { status: 412 }
        objects.set(key, { data, etag: '"' + ++serial + '"' })
        return { status: 201 }
      }
      throw Error('Unexpected bridge method')
    })
    await page.addInitScript(() => {
      window.mygo = {
        call: (method, ...args) =>
          method === 'Desktop.AgentPoll' ? new Promise(() => {}) : window.bridge(method, ...args)
      }
    })
    await page.goto(server.url)
    await page.waitForFunction(() => window.openlr)
    const run = (cmd, args = {}) => page.evaluate(([cmd, args]) => window.openlr.run(cmd, args), [cmd, args])
    return { page, run }
  }
  const a = await device(),
    b = await device(),
    url = { endpoint: 'https://example.test/library/' }
  await a.page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 32
    c.height = 24
    const blob = await new Promise((cb) => c.toBlob(cb, 'image/png'))
    await window.openlr.run('import', { files: [new File([blob], 'shared.png', { type: 'image/png' })] })
  })
  await a.run('rate', { value: 2 })
  assert.equal((await a.run('sync', url)).uploaded, 1)
  assert.equal((await b.run('sync', url)).updated, 1)
  assert.equal((await b.run('state')).photos[0].rating, 2)
  await a.run('rate', { value: 4 })
  await b.run('rate', { value: 5 })
  await a.run('sync', url)
  const conflict = await b.run('sync', url)
  assert.equal(conflict.synced, false)
  assert.equal(conflict.conflicts[0].name, 'shared.png')
  assert.equal((await b.run('state')).photos[0].rating, 5)
  await b.run('sync', { ...url, prefer: 'remote' })
  assert.equal((await b.run('state')).photos[0].rating, 4)
  assert.equal((await b.run('sync', url)).uploaded, 0)
  assert.equal(objects.size, 2)
})
