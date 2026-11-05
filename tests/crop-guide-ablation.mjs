// Run explicitly; records DOM/layout cost, not GPU paint or end-to-end latency.
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

const server = await serveWorkspace()
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  await page.goto(server.url)
  const results = await page.evaluate(async () => {
    const { cropGuideGeometry, cropGuidePath } = await import('./crop-guides.js')
    const results = []
    for (const [width, height] of [
      [480, 300],
      [180, 500]
    ]) {
      const frame = document.createElement('div')
      Object.assign(frame.style, {
        position: 'absolute',
        width: width + 'px',
        height: height + 'px',
        top: '0',
        left: '0'
      })
      document.body.append(frame)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', width)
      svg.setAttribute('height', height)
      const path = document.createElementNS(svg.namespaceURI, 'path')
      svg.append(path)
      const canvas = document.createElement('canvas')
      canvas.width = width * devicePixelRatio
      canvas.height = height * devicePixelRatio
      const ctx = canvas.getContext('2d')
      ctx.scale(devicePixelRatio, devicePixelRatio)
      const d = cropGuidePath(cropGuideGeometry('thirds', width, height).paths)
      const candidates = {
        css() {
          frame.style.backgroundImage = `linear-gradient(to right, transparent 33.2%, white 33.333%, transparent 33.5%, transparent 66.5%, white 66.667%, transparent 66.8%),linear-gradient(to bottom, transparent 33.2%, white 33.333%, transparent 33.5%, transparent 66.5%, white 66.667%, transparent 66.8%)`
        },
        svg() {
          path.setAttribute('d', d)
        },
        canvas() {
          ctx.clearRect(0, 0, width, height)
          ctx.stroke(new Path2D(d))
        }
      }
      const timings = {}
      for (const [name, update] of Object.entries(candidates)) {
        frame.replaceChildren(...(name === 'svg' ? [svg] : name === 'canvas' ? [canvas] : []))
        frame.style.backgroundImage = ''
        const rounds = []
        for (let round = 0; round < 7; round++) {
          const start = performance.now()
          for (let i = 0; i < 1000; i++) {
            update()
            frame.getBoundingClientRect()
          }
          rounds.push(performance.now() - start)
        }
        timings[name] = Number(rounds.sort((a, b) => a - b)[3].toFixed(2))
      }
      results.push({ width, height, millisecondsPer1000Updates: timings })
      frame.remove()
    }
    return { userAgent: navigator.userAgent, devicePixelRatio, results }
  })
  console.log(JSON.stringify(results, null, 2))
  await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 800
    c.height = 600
    const g = c.getContext('2d')
    const gradient = g.createLinearGradient(0, 0, 800, 600)
    gradient.addColorStop(0, '#163858')
    gradient.addColorStop(1, '#d79f65')
    g.fillStyle = gradient
    g.fillRect(0, 0, 800, 600)
    g.fillStyle = '#8ec9b6'
    g.fillRect(100, 170, 180, 260)
    const blob = await new Promise((resolve) => c.toBlob(resolve))
    await window.openlr.run('import', {
      files: [new File([blob], 'composition-study.png', { type: 'image/png' })]
    })
    await window.openlr.run('crop-tool')
    await window.openlr.run('crop-drag', { grip: 'new', x1: 0.08, y1: 0.08, x2: 0.92, y2: 0.92 })
    await window.openlr.run('crop-guide', { type: 'golden-spiral', orientation: 1 })
    document.querySelector('#crop-guide-orientation').scrollIntoView({ block: 'nearest' })
  })
  await page.screenshot({ path: '.workspace/crop-golden-spiral.png' })
  await page.evaluate(() => window.openlr.run('crop-guide', { type: 'aspect-ratios' }))
  await page.screenshot({ path: '.workspace/crop-aspect-ratios.png' })
  await page.setViewportSize({ width: 900, height: 700 })
  await page.locator('#crop-guide').scrollIntoViewIfNeeded()
  await page.screenshot({ path: '.workspace/crop-guides-narrow.png' })
} finally {
  await browser.close()
  await server.close()
}
