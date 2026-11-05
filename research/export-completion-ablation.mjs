import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { serveWorkspace } from '../tests/browser-server.mjs'

const output = new URL('../.workspace/export-previous-ablation/', import.meta.url),
  server = await serveWorkspace(),
  browser = await chromium.launch({ channel: 'chrome', headless: true })
await mkdir(output, { recursive: true })
const report = {
  browser: await browser.version(),
  boundary:
    'Real browser GUI and PNG rendering; only native save API simulated after app startup. Early variant remembers at BeginExport entry, which follows completed encoding and precedes any save outcome.',
  screenshots: [],
  scenarios: []
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  await page.waitForFunction(() => window.openlr)
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 480
    canvas.height = 320
    const g = canvas.getContext('2d'),
      sky = g.createLinearGradient(0, 0, 0, 320)
    sky.addColorStop(0, '#1e506d')
    sky.addColorStop(0.6, '#d2b88d')
    sky.addColorStop(0.61, '#405d59')
    sky.addColorStop(1, '#143b44')
    g.fillStyle = sky
    g.fillRect(0, 0, 480, 320)
    g.fillStyle = '#405d4d'
    g.beginPath()
    g.moveTo(0, 205)
    g.lineTo(140, 80)
    g.lineTo(260, 210)
    g.lineTo(370, 120)
    g.lineTo(480, 205)
    g.closePath()
    g.fill()
    const blob = await new Promise((resolve) => canvas.toBlob(resolve))
    await window.openlr.run('import', {
      files: [new File([blob], 'generated-landscape.png', { type: 'image/png' })]
    })
    await window.openlr.run('view', { mode: 'detail' })
    await window.openlr.run('edit', { key: 'Exposure', value: 0.25 })
  })
  await page.locator('#stage canvas').waitFor()
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({
      path: new URL(`workspace-${width}.png`, output).pathname.replace(/^\/(.:\/)/, '$1')
    })
    report.screenshots.push(
      await page.evaluate(() => {
        const r = document.getElementById('export-previous').getBoundingClientRect()
        return {
          width: innerWidth,
          height: innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          button: { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }
        }
      })
    )
  }
  const old = { format: 'image/png', colorSpace: 'srgb', maxSize: 80 },
    next = { format: 'image/png', colorSpace: 'display-p3', maxSize: 48, watermark: 'Ablation' }
  await page.evaluate(() => {
    window.exportAblation = { early: false, outcome: '', calls: [] }
    window.mygo = {
      call: async (method, ...args) => {
        const experiment = window.exportAblation
        experiment.calls.push({
          method,
          ...(method === 'Desktop.WriteExport'
            ? {
                bytes: atob(args[1]).length,
                signature: Array.from(atob(args[1]).slice(0, 8), (c) => c.charCodeAt(0))
              }
            : {})
        })
        if (method === 'Desktop.BeginExport') {
          // The application only invokes BeginExport after run('export') has
          // returned its real encoded Blob. This temporary variant changes the
          // remember point while leaving production source and encoding intact.
          if (experiment.early) {
            const { readExportOptions } = await import('./export-options.js')
            experiment.earlyOptions = readExportOptions()
            experiment.earlyResult = await window.openlr.run('export-settings', {
              media: 'photo',
              options: experiment.earlyOptions
            })
          }
          experiment.beginComplete = true
          return experiment.outcome === 'cancel' ? '' : 'ablation-transfer'
        }
        if (method === 'Desktop.WriteExport') throw Error('Ablation write failed')
        if (method === 'Desktop.CancelExport') return
        throw Error('Unexpected native operation ' + method)
      }
    }
  })
  for (const early of [false, true])
    for (const outcome of ['cancel', 'write-failure']) {
      await page.evaluate(async (old) => {
        await window.openlr.run('export-settings', { media: 'photo', options: old })
        document.getElementById('notice').textContent = ''
      }, old)
      await page.evaluate(
        ({ early, outcome }) =>
          Object.assign(window.exportAblation, {
            early,
            outcome,
            calls: [],
            beginComplete: false,
            earlyOptions: null,
            earlyResult: null
          }),
        { early, outcome }
      )
      await page.locator('#export').click()
      await page.locator('#format').selectOption(next.format)
      await page.locator('#export-color-space').selectOption(next.colorSpace)
      await page.locator('#export-size').fill(String(next.maxSize))
      await page.locator('#watermark').fill(next.watermark)
      await page.locator('#export-dialog button[value=ok]').click()
      if (outcome === 'write-failure')
        await page.waitForFunction(
          () => document.getElementById('notice').textContent === 'Ablation write failed'
        )
      else await page.waitForFunction(() => window.exportAblation.beginComplete)
      const observed = await page.evaluate(async () => ({
        ...window.exportAblation,
        settings: await window.openlr.run('export-settings'),
        notice: document.getElementById('notice').textContent
      }))
      console.log(JSON.stringify({ early, outcome, observed }))
      assert.deepEqual(observed.settings.photo, early ? next : old)
      assert.deepEqual(
        observed.calls.map((call) => call.method),
        outcome === 'cancel'
          ? ['Desktop.BeginExport']
          : ['Desktop.BeginExport', 'Desktop.WriteExport', 'Desktop.CancelExport']
      )
      if (outcome === 'write-failure')
        assert.deepEqual(observed.calls[1].signature, [137, 80, 78, 71, 13, 10, 26, 10])
      report.scenarios.push({
        variant: early ? 'remember-after-encode' : 'remember-after-completion',
        outcome,
        before: old,
        attempted: next,
        remembered: observed.settings.photo,
        saved: false,
        calls: observed.calls,
        notice: observed.notice
      })
    }
  report.result =
    'All four actual GUI scenarios matched the expected distinction: completion policy retains prior settings after cancel/write failure; early policy replaces them despite no saved output.'
  await writeFile(new URL('results.json', output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  await browser.close()
  await server.close()
}
