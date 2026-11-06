import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

async function workspace(t, { stalled = false, moduleFailure = false } = {}) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.addInitScript((holdCatalog) => {
    globalThis.openlrDiagnostics = true
    globalThis.startupStages = []
    globalThis.startupReplies = {}
    const pending = new Promise(() => {})
    if (holdCatalog) {
      const request = {}
      indexedDB.open = () => request
      globalThis.rejectStartupCatalog = () => {
        request.error = new Error('Controlled private catalog detail')
        request.onerror()
      }
    }
    const delivered = new Set()
    globalThis.mygo = {
      call(method, ...args) {
        if (method === 'Desktop.StartupMilestone') {
          globalThis.startupStages.push(args)
          return pending
        }
        if (method === 'Desktop.AgentReply') {
          globalThis.startupReplies[args[0]] = JSON.parse(args[1])
          return Promise.resolve()
        }
        if (method === 'Local.Folders') return Promise.resolve([])
        if (method === 'External.Editor') return Promise.resolve('')
        if (method === 'Sharing.State') return Promise.resolve({})
        if (delivered.has(method)) return pending
        delivered.add(method)
        if (method === 'Desktop.AgentPoll') return Promise.resolve({ id: 'ordinary', command: 'state' })
        if (method === 'Desktop.AgentPollControl')
          return Promise.resolve({ id: 'control', command: 'export-status' })
        throw Error('Unexpected test bridge method')
      }
    }
  }, stalled)
  if (moduleFailure) await page.route('**/agent.js', (route) => route.abort())
  await page.goto(server.url)
  return page
}

test('startup reports renderer, catalog and both command lanes without waiting for diagnostic IPC', async (t) => {
  const page = await workspace(t)
  await page.waitForFunction(() => window.startupReplies.ordinary && window.startupReplies.control, null, {
    timeout: 5000
  })
  const { events, replies } = await page.evaluate(() => ({
    events: window.startupStages,
    replies: window.startupReplies
  }))
  const stages = events.map(([name]) => name)
  assert.ok(events.every((args) => args.length === 1))
  assert.equal(stages[0], 'renderer-script')
  for (const stage of [
    'renderer-agent-ready',
    'catalog-read-started',
    'catalog-read-finished',
    'workspace-ready'
  ])
    assert.ok(stages.includes(stage))
  assert.ok(stages.indexOf('catalog-read-started') < stages.indexOf('catalog-read-finished'))
  assert.ok(stages.indexOf('catalog-read-finished') < stages.indexOf('workspace-ready'))
  assert.ok(stages.indexOf('workspace-ready') < stages.indexOf('ordinary-dispatch-finished'))
  for (const lane of ['ordinary', 'control']) {
    assert.equal(stages.filter((stage) => stage === lane + '-renderer-received').length, 1)
    assert.ok(stages.indexOf(lane + '-renderer-received') < stages.indexOf(lane + '-dispatch-finished'))
    assert.equal(replies[lane].ok, true)
  }
})

test('a failed catalog leaves an ordinary reply failure and separate working control without logging details', async (t) => {
  const page = await workspace(t, { stalled: true })
  await page.waitForFunction(
    () =>
      window.startupReplies.control &&
      window.startupStages.some(([name]) => name === 'ordinary-renderer-received'),
    null,
    { timeout: 5000 }
  )
  assert.equal(await page.evaluate(() => window.startupReplies.ordinary), undefined)
  await page.evaluate(() => window.rejectStartupCatalog())
  await page.waitForFunction(() => window.startupReplies.ordinary, null, { timeout: 5000 })
  const { stages, replies } = await page.evaluate(() => ({
    stages: window.startupStages,
    replies: window.startupReplies
  }))
  assert.deepEqual(replies.control, { ok: true, result: null })
  assert.equal(replies.ordinary.error.message, 'Controlled private catalog detail')
  assert.equal(await page.locator('#notice').textContent(), 'Controlled private catalog detail')
  assert.ok(stages.some(([stage]) => stage === 'workspace-ready-failed'))
  assert.ok(stages.some(([stage]) => stage === 'ordinary-dispatch-finished'))
  assert.ok(!stages.some(([stage]) => stage === 'workspace-ready' || stage === 'catalog-read-finished'))
  assert.ok(!JSON.stringify(stages).includes('Controlled private catalog detail'))
})

test('a blocked module records a fixed failure stage and keeps the visible startup error', async (t) => {
  const page = await workspace(t, { moduleFailure: true })
  await page.waitForFunction(
    () => window.startupStages.some(([name]) => name === 'renderer-script-failed'),
    null,
    { timeout: 5000 }
  )
  assert.deepEqual(await page.evaluate(() => window.startupStages), [
    ['renderer-script'],
    ['renderer-script-failed']
  ])
  assert.match(await page.locator('#notice').textContent(), /Could not open the workspace/)
})
