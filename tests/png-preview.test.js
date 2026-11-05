import { waitForAsyncFunction } from './browser-wait.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('legacy PNG previews refresh dimensions and orientation without changing originals or recipes', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const fixture = Array.from(await readFile(new URL('./fixtures/export-metadata.png', import.meta.url)))
  for (const scenario of [
    'visibility',
    'queued row replacement',
    'without IntersectionObserver',
    'edit before visibility'
  ]) {
    await t.test(scenario, async (t) => {
      const page = await browser.newPage()
      t.after(() => page.close())
      await page.goto(server.url)
      const initial = await page.evaluate(async (bytes) => {
        const { run } = await import('./app.js'),
          db = await import('./catalog.js')
        const imported = await run('import', {
          files: [new File([new Uint8Array(bytes)], 'legacy.png', { type: 'image/png' })]
        })
        const id = imported.added[0]
        await run('edit', { key: 'Exposure', value: 0.5 })
        const photo = (await db.all('photos')).find((p) => p.id === id)
        const version = photo.pngPreviewVersion,
          edit = photo.edit
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 24
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ff00ff'
        ctx.fillRect(0, 0, 32, 24)
        photo.thumbnail = await new Promise((resolve) => canvas.toBlob(resolve))
        photo.width = 32
        photo.height = 24
        delete photo.pngPreviewVersion
        await db.save('photos', photo)
        return { id, version, edit }
      }, fixture)
      assert.equal(initial.version, 1, 'New imports/edits already have the current preview stamp')
      if (scenario === 'queued row replacement' || scenario === 'edit before visibility')
        await page.addInitScript(() => {
          window.thumbnailObservers = []
          window.IntersectionObserver = class {
            constructor(callback) {
              this.callback = callback
            }
            observe(element) {
              this.element = element
              window.thumbnailObservers.push(this)
            }
            disconnect() {
              this.disconnected = true
            }
          }
        })
      else if (scenario === 'without IntersectionObserver')
        await page.addInitScript(() => {
          window.IntersectionObserver = undefined
        })
      await page.reload()
      if (scenario === 'queued row replacement')
        await page.evaluate(async () => {
          const { run } = await import('./app.js')
          await run('state')
          const rate = run('rate', { value: 2 })
          for (const observer of [...window.thumbnailObservers])
            if (!observer.disconnected && observer.element.isConnected)
              observer.callback([{ isIntersecting: true }])
          await rate
          await run('state')
          for (const observer of [...window.thumbnailObservers])
            if (!observer.disconnected && observer.element.isConnected)
              observer.callback([{ isIntersecting: true }])
        })
      else if (scenario === 'edit before visibility')
        await page.evaluate(async (id) => {
          const { run } = await import('./app.js')
          await run('select', { id })
          await run('edit', { key: 'Exposure', value: 1 })
        }, initial.id)
      await waitForAsyncFunction(
        page,
        async (id) => {
          const db = await import('./catalog.js')
          const photo = (await db.all('photos')).find((p) => p.id === id)
          return photo?.pngPreviewVersion === 1 && photo.width === 24 && photo.height === 32
        },
        initial.id
      )
      await page.waitForFunction((id) => {
        const image = document.querySelector(`[data-photo="${id}"] img`)
        return (
          image?.complete &&
          image.currentSrc === image.src &&
          image.naturalWidth === 24 &&
          image.naturalHeight === 32
        )
      }, initial.id)
      const result = await page.evaluate(async (id) => {
        const db = await import('./catalog.js'),
          photo = (await db.all('photos')).find((p) => p.id === id)
        const tile = document.querySelector(`[data-photo="${id}"]`)
        const thumbnail = await createImageBitmap(photo.thumbnail),
          canvas = document.createElement('canvas')
        canvas.width = thumbnail.width
        canvas.height = thumbnail.height
        const context = canvas.getContext('2d')
        context.drawImage(thumbnail, 0, 0)
        thumbnail.close()
        return {
          edit: photo.edit,
          rating: photo.rating,
          aspect: Number(tile.style.getPropertyValue('--aspect')),
          center: Array.from(context.getImageData(12, 16, 1, 1).data),
          bytes: Array.from(new Uint8Array(await (await db.original(id)).file.arrayBuffer()))
        }
      }, initial.id)
      assert.deepEqual(
        result.edit,
        scenario === 'edit before visibility' ? { ...initial.edit, Exposure: 1 } : initial.edit
      )
      assert.equal(result.rating, scenario === 'queued row replacement' ? 2 : 0)
      assert.equal(result.aspect, 24 / 32)
      assert.notDeepEqual(result.center, [255, 0, 255, 255], 'Stale magenta thumbnail was replaced')
      assert.deepEqual(result.bytes, fixture)
    })
  }
})
