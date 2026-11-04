import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { readFile } from 'node:fs/promises'

test('real face and eye landmarks drive localized correction; blur lowers focus on the same scene', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const photo = await readFile(new URL('./fixtures/ai/astronaut.png', import.meta.url))
  const result = await page.evaluate(async (encoded) => {
    const file = new File([Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))], 'sharp.png', {
      type: 'image/png'
    })
    const img = await createImageBitmap(file),
      c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d', { willReadFrequently: true }),
      run = window.openlr.run
    const blob = () => new Promise((resolve) => c.toBlob(resolve, 'image/png'))
    await run('import', { files: [file] })
    const sharp = (await run('cull')).scores[0].review
    ctx.filter = 'blur(4px)'
    ctx.drawImage(img, 0, 0)
    ctx.filter = 'none'
    await run('import', { files: [new File([await blob()], 'soft.png', { type: 'image/png' })] })
    const soft = (await run('cull')).scores[0].review
    const eye = sharp.faces[0].eyes[0],
      x = Math.round(eye.x * c.width),
      y = Math.round(eye.y * c.height)
    ctx.drawImage(img, 0, 0)
    img.close()
    ctx.fillStyle = '#f51d16'
    ctx.fillRect(x - 1, y - 1, 3, 3)
    ctx.fillRect(5, 5, 3, 3)
    await run('import', { files: [new File([await blob()], 'flash.png', { type: 'image/png' })] })
    const corrected = await run('red-eye')
    const out = await run('export', { format: 'image/png' }),
      edited = await createImageBitmap(out.blob)
    ctx.drawImage(edited, 0, 0)
    edited.close()
    return {
      faces: sharp.faces.length,
      score: sharp.faces[0].confidence,
      sharp: sharp.focus,
      soft: soft.focus,
      regions: corrected.eyeRegions,
      pupil: ctx.getImageData(x, y, 1, 1).data[0],
      control: ctx.getImageData(6, 6, 1, 1).data[0]
    }
  }, photo.toString('base64'))
  console.log('Focus/eye check', result)
  assert.ok(result.faces >= 1 && result.score > 0.8)
  assert.ok(result.sharp > result.soft * 2)
  assert.ok(result.regions >= 2 && result.pupil < 100)
  assert.equal(result.control, 245)
})
