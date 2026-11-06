import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

async function workspace(t) {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  return page
}

test('catalog JPEG encoding matches the previous canvas encoder for opaque and translucent thumbnails', async (t) => {
  const page = await workspace(t)
  const observations = await page.evaluate(async () => {
    const { encodeThumbnail } = await import('/encode.js')
    const { toBlob } = await import('/render.js')
    const bytes = async (blob) => Array.from(new Uint8Array(await blob.arrayBuffer()))
    const pixels = async (blob) => {
      const bitmap = await createImageBitmap(blob)
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data)
      } finally {
        bitmap.close()
      }
    }
    const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])
    const results = []
    for (const [width, height, transparent] of [
      [240, 151, false],
      [9, 13, true],
      [133, 240, true]
    ]) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d'),
        image = ctx.createImageData(width, height)
      for (let i = 0; i < width * height; i++)
        image.data.set([i % 255, (i * 17) % 255, 127, transparent ? i % 256 : 255], i * 4)
      ctx.putImageData(image, 0, 0)
      const expected = await toBlob(canvas),
        actual = encodeThumbnail(canvas)
      results.push({
        type: actual.type,
        sameBytes: equal(await bytes(expected), await bytes(actual)),
        samePixels: equal(await pixels(expected), await pixels(actual))
      })
    }
    const empty = document.createElement('canvas')
    empty.width = 0
    try {
      encodeThumbnail(empty)
      results.push('empty canvas accepted')
    } catch (error) {
      results.push(error.message)
    }
    return results
  })
  assert.deepEqual(observations, [
    ...Array.from({ length: 3 }, () => ({ type: 'image/jpeg', sameBytes: true, samePixels: true })),
    'Image export failed'
  ])
})

test('cropped edit thumbnails keep the previous JPEG bytes through catalog reopen and failed replacement', async (t) => {
  const page = await workspace(t)
  const fixture = await page.evaluate(async () => {
    const { toBlob } = await import('/render.js')
    const canvas = document.createElement('canvas')
    canvas.width = 460
    canvas.height = 320
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#355c94'
    ctx.fillRect(0, 0, 315, 320)
    ctx.fillStyle = '#a65b3d'
    ctx.fillRect(315, 0, 145, 320)
    const png = await toBlob(canvas, 'image/png')
    return Array.from(new Uint8Array(await png.arrayBuffer()))
  })
  await page
    .locator('#files')
    .setInputFiles({ name: 'haze.png', mimeType: 'image/png', buffer: Buffer.from(fixture) })
  await page.waitForFunction(() => document.querySelector('#gallery .tile img')?.src.startsWith('blob:'))

  const beforeReload = await page.evaluate(async (fixture) => {
    const { original } = await import('/catalog.js')
    const { decodeEditSource } = await import('/edit-source.js')
    const { renderPrepared, toBlob } = await import('/render.js')
    const run = window.openlr.run
    const bytes = async (blob) => Array.from(new Uint8Array(await blob.arrayBuffer()))
    const matching = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])
    const [photo] = (await run('state')).photos
    const oldThumbnail = async (edit) => {
      const file = new File([Uint8Array.from(fixture)], photo.name, { type: 'image/png' })
      const source = await decodeEditSource(file, edit)
      try {
        return bytes(await toBlob(await renderPrepared(source, edit, 240)))
      } finally {
        source.close()
      }
    }
    const checks = []
    let committedThumbnail
    for (const version of [1, 2]) {
      await run('processing', { version })
      await run('edit', { key: 'crop', value: { x: 0.1, y: 0.1, w: 0.75, h: 0.75 } })
      const edited = (await run('edit', { key: 'Exposure', value: version / 2 })).photos[0]
      const thumbnail = await (await fetch(document.querySelector('#gallery .tile img').src)).blob()
      const bitmap = await createImageBitmap(thumbnail)
      committedThumbnail = await bytes(thumbnail)
      checks.push({
        matched: matching(committedThumbnail, await oldThumbnail(edited.edit)),
        type: thumbnail.type,
        size: [bitmap.width, bitmap.height]
      })
      bitmap.close()
    }
    const { file } = await original(photo.id)
    const native = HTMLCanvasElement.prototype.toDataURL
    let failure
    HTMLCanvasElement.prototype.toDataURL = () => 'data:,'
    try {
      await run('edit', { key: 'Exposure', value: 2 })
    } catch (error) {
      failure = error.message
    } finally {
      HTMLCanvasElement.prototype.toDataURL = native
    }
    const preserved = (await run('state')).photos[0].edit
    const preservedThumbnail = await bytes(
      await (await fetch(document.querySelector('#gallery .tile img').src)).blob()
    )
    return {
      checks,
      original: matching(await bytes(file), fixture),
      failure,
      preserved,
      thumbnail: committedThumbnail,
      thumbnailPreserved: matching(committedThumbnail, preservedThumbnail)
    }
  }, fixture)
  assert.deepEqual(
    beforeReload.checks,
    Array.from({ length: 2 }, () => ({ matched: true, type: 'image/jpeg', size: [240, 167] }))
  )
  assert.equal(beforeReload.original, true)
  assert.equal(beforeReload.failure, 'Image export failed')
  assert.equal(beforeReload.preserved.Exposure, 1)
  assert.equal(beforeReload.thumbnailPreserved, true)

  await page.reload()
  await page.waitForFunction(() => document.querySelector('#gallery .tile img')?.src.startsWith('blob:'))
  const reopened = await page.evaluate(async () => ({
    edit: (await window.openlr.run('state')).photos[0].edit,
    thumbnail: Array.from(
      new Uint8Array(await (await fetch(document.querySelector('#gallery .tile img').src)).arrayBuffer())
    )
  }))
  assert.deepEqual(reopened.edit, beforeReload.preserved)
  assert.deepEqual(reopened.thumbnail, beforeReload.thumbnail)
})
