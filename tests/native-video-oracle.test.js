import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { ownVideoOracle } from '../scripts/native-video-oracle.mjs'

async function launchOracle(t) {
  let owner
  try {
    owner = await chromium.launchServer({
      ...(process.env.OPENLR_VIDEO_PROBE_CHROME
        ? { executablePath: process.env.OPENLR_VIDEO_PROBE_CHROME }
        : { channel: process.env.CHROME_CHANNEL || 'chrome' }),
      host: '127.0.0.1',
      timeout: 10_000
    })
  } catch (error) {
    if (/Chromium distribution .* is not found|Executable doesn't exist at/.test(error.message)) {
      t.skip('Chrome executable is unavailable')
      return
    }
    throw error
  }
  t.after(async () => {
    let timer
    try {
      await Promise.race([
        owner.kill(),
        new Promise((resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`Oracle test teardown deadline; process exited: ${terminated(owner.process())}`)
              ),
            5000
          )
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  })
  return owner
}

const terminated = (child) => child.exitCode !== null || child.signalCode !== null

test('video oracle graceful cleanup confirms the actual owned Chrome process exited', async (t) => {
  const owner = await launchOracle(t)
  if (!owner) return
  const records = []
  const oracle = ownVideoOracle(owner, { log: (line) => records.push(JSON.parse(line)) })
  const browser = await chromium.connect(owner.wsEndpoint(), { timeout: 10_000 })
  const page = await browser.newPage()
  assert.equal(await page.evaluate(() => 6 * 7), 42)
  assert.equal(terminated(owner.process()), false)
  await oracle.close()
  assert.equal(terminated(owner.process()), true)
  assert.equal(records.find((record) => record.nativeVideoOracle === 'owned').pid, owner.process().pid)
  const phases = records.map((record) => record.nativeVideoOracleCleanup)
  assert.ok(phases.indexOf('process-exited') < phases.indexOf('confirmed'))
  assert.equal(phases.includes('kill-requested'), false)
  assert.equal(records.find((record) => record.nativeVideoOracleCleanup === 'confirmed').method, 'graceful')
})

test('video oracle escalates a hanging graceful operation and kills only its owned real Chrome', async (t) => {
  const owner = await launchOracle(t)
  if (!owner) return
  const records = []
  let kills = 0
  const oracle = ownVideoOracle(
    {
      process: () => owner.process(),
      close: () => new Promise(() => {}),
      kill: () => {
        kills++
        return owner.kill()
      }
    },
    { closeMs: 100, killMs: 5000, log: (line) => records.push(JSON.parse(line)) }
  )
  const browser = await chromium.connect(owner.wsEndpoint(), { timeout: 10_000 })
  assert.equal(await (await browser.newPage()).evaluate(() => 42), 42)
  await oracle.close()
  assert.equal(kills, 1)
  assert.equal(terminated(owner.process()), true)
  const phases = records.map((record) => record.nativeVideoOracleCleanup)
  assert.ok(phases.indexOf('close-deadline') < phases.indexOf('kill-requested'))
  assert.ok(phases.indexOf('process-exited') < phases.indexOf('confirmed'))
  assert.equal(records.find((record) => record.nativeVideoOracleCleanup === 'confirmed').method, 'killed')
})

test('video oracle refuses confirmation when shutdown methods resolve but real Chrome stays alive', async (t) => {
  const owner = await launchOracle(t)
  if (!owner) return
  const records = []
  const oracle = ownVideoOracle(
    { process: () => owner.process(), close: async () => {}, kill: async () => {} },
    { closeMs: 50, killMs: 50, log: (line) => records.push(JSON.parse(line)) }
  )
  await assert.rejects(oracle.close(), /could not confirm termination/)
  assert.equal(terminated(owner.process()), false)
  assert.equal(
    records.some((record) => record.nativeVideoOracleCleanup === 'confirmed'),
    false
  )
  assert.equal(
    records.some((record) => record.nativeVideoOracleCleanup === 'failed'),
    true
  )
})
