import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makePng } from './fixtures/png.mjs'

const width = 360,
  height = 240
const colors = [
  [170, 32, 44],
  [41, 166, 57],
  [43, 56, 170],
  [162, 143, 28]
]
function fixture(palette) {
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const quadrant = Number(x >= width / 2) + 2 * Number(y >= height / 2)
      data.set(palette[quadrant], (y * width + x) * 3)
    }
  }
  return Buffer.from(makePng({ width, height, bits: 8, colorType: 2, srgb: 0, data }))
}
const originals = [fixture(colors), fixture([...colors].reverse())]
const editOf = (state, id = state.selected) => state.photos.find((photo) => photo.id === id).edit

function image(page, command) {
  return page.evaluate(async (command) => {
    const { blob } = await window.openlr.run(command, command === 'preview' ? {} : { format: 'image/png' })
    const image = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    image.close()
    const samples = []
    for (const y of [0.25, 0.75]) {
      for (const x of [0.25, 0.75]) {
        samples.push(
          Array.from(
            ctx.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data
          ).slice(0, 3)
        )
      }
    }
    return { width: canvas.width, height: canvas.height, samples }
  }, command)
}

async function holdThumbnail(page, control, type = 'click') {
  await page.evaluate(
    ({ control, type }) => {
      const toBlob = HTMLCanvasElement.prototype.toBlob
      const hold = (window.controlHold = { release: null, trustedEvents: 0 })
      document.querySelector(control).addEventListener(type, (event) => {
        if (event.isTrusted) hold.trustedEvents++
      })
      HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
        if (Math.max(this.width, this.height) !== 240) return toBlob.call(this, callback, ...args)
        HTMLCanvasElement.prototype.toBlob = toBlob
        // Keep the real encoder and delay only delivery of its completed thumbnail.
        return toBlob.call(this, (blob) => (hold.release = () => callback(blob)), ...args)
      }
    },
    { control, type }
  )
}

async function queuePhotoChange(page, id) {
  await page.evaluate((id) => {
    window.openlr.run('edit', { key: 'Contrast', value: 20 })
    if (id) window.openlr.run('select', { id })
  }, id)
  await page.waitForFunction(() => Boolean(window.controlHold.release))
}

test('queued controls use the intended photo and apply relative actions once', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  t.diagnostic('Chrome ' + browser.version())
  async function workspace(t) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    t.after(() => page.close())
    const run = (command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
    await page.goto(server.url)
    await page.waitForFunction(() => window.openlr)
    await page
      .locator('#files')
      .setInputFiles(originals.map((buffer, i) => ({ name: `${i}.png`, mimeType: 'image/png', buffer })))
    await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 2)
    const { photos } = await run('state'),
      first = photos.find(({ name }) => name === '0.png').id,
      second = photos.find(({ name }) => name === '1.png').id
    await run('select', { id: first })
    await run('view', { mode: 'detail' })
    await page.getByText('Crop & rotate', { exact: true }).click()
    return { page, run, first, second }
  }

  await t.test('two rapid turns and flips each apply once with independent pixels and history', async (t) => {
    const { page, run, first } = await workspace(t)
    for (const [button, expected] of [
      ['#right', { turn: 2 }],
      ['#flip', { turn: 2, flip: false }]
    ]) {
      await holdThumbnail(page, button)
      await page.locator(button).click()
      await page.waitForFunction(() => Boolean(window.controlHold.release))
      await page.locator(button).click()
      assert.equal(await page.evaluate(() => window.controlHold.trustedEvents), 2)
      await page.evaluate(() => window.controlHold.release())
      assert.deepEqual(editOf(await run('state')), expected)
    }
    const upsideDown = { width, height, samples: [...colors].reverse() }
    assert.deepEqual(await image(page, 'preview'), upsideDown)
    assert.deepEqual(await image(page, 'export'), upsideDown)
    assert.deepEqual(editOf(await run('undo')), { turn: 2, flip: true })
    assert.deepEqual(editOf(await run('undo')), { turn: 2 })
    assert.deepEqual(editOf(await run('undo')), { turn: 1 })
    assert.deepEqual(await image(page, 'export'), {
      width: height,
      height: width,
      samples: [colors[2], colors[0], colors[3], colors[1]]
    })
    assert.deepEqual(editOf(await run('undo')), {})

    assert.deepEqual(editOf(await run('rotate', { direction: 'left', photoId: first })), { turn: 3 })
    assert.deepEqual(editOf(await run('flip', { photoId: first })), { turn: 3, flip: true })
    await assert.rejects(() => run('rotate', { direction: 'half' }), /direction/i)
    await run('edit', { key: 'turn', value: 2 })
    await run('edit', { key: 'flip', value: false })
    assert.deepEqual(await image(page, 'export'), upsideDown)
    await page.reload()
    await page.waitForFunction(() => window.openlr)
    await run('select', { id: first })
    assert.deepEqual(editOf(await run('state')), { turn: 2, flip: false })
    const bytes = await page.evaluate(async () => {
      const { blob } = await window.openlr.run('export', { format: 'original' })
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    })
    assert.deepEqual(Buffer.from(bytes), originals[0])
  })

  await t.test('a click made before queued photo selection cannot flip the new photo', async (t) => {
    const { page, run, first, second } = await workspace(t)
    await holdThumbnail(page, '#flip')
    await queuePhotoChange(page, second)
    await page.locator('#flip').click()
    assert.equal(await page.evaluate(() => window.controlHold.trustedEvents), 1)
    await page.evaluate(() => window.controlHold.release())
    const state = await run('state')
    assert.equal(state.selected, second)
    assert.deepEqual(editOf(state, first), { Contrast: 20 })
    assert.deepEqual(editOf(state, second), {})
    assert.match(await page.locator('#notice').textContent(), /selected photo changed/i)
    await assert.rejects(() => run('flip', { photoId: first }), /selected photo changed/i)
    assert.deepEqual(editOf(await run('undo')), {}, 'A rejected click did not enter the new photo history')
    const unflipped = await image(page, 'export')
    assert.deepEqual(unflipped, { width, height, samples: [...colors].reverse() })
    await page.locator('#flip').click()
    assert.deepEqual(editOf(await run('state')), { flip: true })
    assert.deepEqual(await image(page, 'export'), {
      width,
      height,
      samples: [colors[2], colors[3], colors[0], colors[1]]
    })
  })

  await t.test(
    'a basic adjustment committed before selection changes cannot edit the new photo',
    async (t) => {
      const { page, run, first, second } = await workspace(t)
      const exposure = '[data-control="Exposure"]'
      await holdThumbnail(page, exposure, 'change')
      await queuePhotoChange(page, second)
      await page.locator(exposure).press('ArrowRight')
      assert.equal(await page.locator(exposure).inputValue(), '0.05')
      assert.equal(await page.evaluate(() => window.controlHold.trustedEvents), 1)
      await page.evaluate(() => window.controlHold.release())
      const after = await run('state')
      assert.equal(after.selected, second)
      assert.deepEqual(editOf(after, first), { Contrast: 20 })
      assert.deepEqual(editOf(after, second), {})
      assert.match(await page.locator('#notice').textContent(), /selected photo changed/i)
      assert.deepEqual(editOf(await run('undo')), {})
      await assert.rejects(
        () => run('edit', { key: 'Exposure', value: 1, photoId: first }),
        /selected photo changed/i
      )
      const unedited = { width, height, samples: [...colors].reverse() }
      assert.deepEqual(await image(page, 'export'), unedited)
      await page.locator(exposure).press('ArrowRight')
      assert.deepEqual(editOf(await run('state')), { Exposure: 0.05 })
      assert.notDeepEqual(await image(page, 'export'), unedited)
      assert.deepEqual(editOf(await run('undo')), {})
      assert.deepEqual(editOf(await run('edit', { key: 'Exposure', value: 0.5, photoId: second })), {
        Exposure: 0.5
      })
    }
  )

  await t.test('point sliders and removal cannot modify a copied ID on the new photo', async (t) => {
    const { page, run, first, second } = await workspace(t)
    const point = await run('point-add', { color: '#a28f1c' })
    await run('copy-edits')
    await run('select', { id: second })
    await run('paste-edits')
    await run('select', { id: first })
    await run('panel', { name: 'Point color', open: true })
    const hue = '[aria-label="Point hue"]'
    for (const [selector, type, action] of [
      [hue, 'change', () => page.locator(hue).press('ArrowRight')],
      ['aside', 'click', () => page.getByRole('button', { name: 'Delete sample', exact: true }).click()]
    ]) {
      await run('select', { id: first })
      await holdThumbnail(page, selector, type)
      await queuePhotoChange(page, second)
      await action()
      assert.equal(await page.evaluate(() => window.controlHold.trustedEvents), 1)
      await page.evaluate(() => window.controlHold.release())
      const after = await run('state')
      assert.equal(after.selected, second)
      assert.deepEqual(editOf(after, first).pointColors, [point])
      assert.deepEqual(editOf(after, second).pointColors, [point])
      assert.match(await page.locator('#notice').textContent(), /selected photo changed/i)
    }
    const unedited = await image(page, 'export')
    await assert.rejects(
      () => run('point-update', { id: point.id, hue: 90, photoId: first }),
      /selected photo changed/i
    )
    await assert.rejects(
      () => run('point-remove', { id: point.id, photoId: first }),
      /selected photo changed/i
    )
    const updated = await run('point-update', { id: point.id, hue: 90, photoId: second })
    assert.deepEqual(editOf(updated).pointColors, [{ ...point, hue: 90 }])
    assert.notDeepEqual(await image(page, 'export'), unedited)
    await page.getByRole('button', { name: 'Delete sample', exact: true }).click()
    assert.deepEqual(editOf(await run('state')).pointColors, [])
    assert.deepEqual(await image(page, 'export'), unedited)
    assert.deepEqual(editOf(await run('undo')).pointColors, [{ ...point, hue: 90 }])
    assert.deepEqual(editOf(await run('undo')).pointColors, [point])
    await page.reload()
    await page.waitForFunction(() => window.openlr)
    const reopened = await run('state')
    assert.deepEqual(editOf(reopened, first).pointColors, [point])
    assert.deepEqual(editOf(reopened, second).pointColors, [point])
  })

  await t.test('each queued layout switch toggles the current Grid layout', async (t) => {
    const { page, run } = await workspace(t)
    await run('grid-layout', { layout: 'square' })
    await page.evaluate(() => {
      window.layoutChanges = []
      const gallery = document.getElementById('gallery')
      window.addEventListener('openlr-change', () => window.layoutChanges.push(gallery.dataset.layout))
    })
    await holdThumbnail(page, '#layout')
    await queuePhotoChange(page)
    await page.locator('#layout').click()
    await page.locator('#layout').click()
    assert.equal(await page.evaluate(() => window.controlHold.trustedEvents), 2)
    await page.evaluate(() => window.controlHold.release())
    assert.equal((await run('state')).gridLayout, 'square')
    assert.equal(await page.locator('#gallery').getAttribute('data-layout'), 'square')
    assert.deepEqual(await page.evaluate(() => window.layoutChanges), ['square', 'mosaic', 'square'])
    assert.equal((await run('grid-layout')).gridLayout, 'mosaic')
    assert.equal(await page.locator('#gallery').getAttribute('data-layout'), 'mosaic')
    await page.reload()
    await page.waitForFunction(() => window.openlr)
    assert.equal((await run('state')).gridLayout, 'mosaic')
    assert.equal((await run('grid-layout', { layout: 'square' })).gridLayout, 'square')
  })
})
