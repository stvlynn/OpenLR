import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { holdCatalogThumbnail } from './catalog-thumbnail-hold.mjs'
import { makePng } from './fixtures/png.mjs'
import { makeVideoFixture } from './fixtures/video.mjs'

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

async function expectVideoColor(page, channel) {
  const preview = await image(page, 'preview')
  assert.deepEqual([preview.width, preview.height], [96, 64])
  assert.ok(
    preview.samples.every(
      (pixel) =>
        pixel[channel] > 120 && pixel.every((value, i) => i === channel || value < pixel[channel] - 30)
    ),
    JSON.stringify(preview.samples)
  )
}

async function holdThumbnail(page, control, type = 'click') {
  await holdCatalogThumbnail(page)
  await page.evaluate(
    ({ control, type }) => {
      const hold = window.catalogThumbnailHold
      hold.trustedEvents = 0
      document.querySelector(control).addEventListener(type, (event) => {
        if (event.isTrusted) hold.trustedEvents++
      })
    },
    { control, type }
  )
}

async function queuePhotoChange(page, id) {
  await page.evaluate((id) => {
    window.openlr.run('edit', { key: 'Contrast', value: 20 })
    if (id) window.openlr.run('select', { id })
  }, id)
  await page.waitForFunction(() => Boolean(window.catalogThumbnailHold.release))
}

test('queued controls use the intended photo and apply relative actions once', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  t.diagnostic('Chrome ' + browser.version())
  async function openWorkspace(t) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    t.after(() => page.close())
    const run = (command, args = {}) => page.evaluate(([c, a]) => window.openlr.run(c, a), [command, args])
    await page.goto(server.url)
    await page.waitForFunction(() => window.openlr)
    return { page, run }
  }
  async function workspace(t, files = originals) {
    const { page, run } = await openWorkspace(t)
    await page
      .locator('#files')
      .setInputFiles(files.map((buffer, i) => ({ name: `${i}.png`, mimeType: 'image/png', buffer })))
    await page.waitForFunction(
      (count) => document.querySelectorAll('#gallery .tile').length === count,
      files.length
    )
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
      await page.waitForFunction(() => Boolean(window.catalogThumbnailHold.release))
      await page.locator(button).click()
      assert.equal(await page.evaluate(() => window.catalogThumbnailHold.trustedEvents), 2)
      await page.evaluate(() => window.catalogThumbnailHold.release())
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
    assert.equal(await page.evaluate(() => window.catalogThumbnailHold.trustedEvents), 1)
    await page.evaluate(() => window.catalogThumbnailHold.release())
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
      assert.equal(await page.evaluate(() => window.catalogThumbnailHold.trustedEvents), 1)
      await page.evaluate(() => window.catalogThumbnailHold.release())
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
      assert.equal(await page.evaluate(() => window.catalogThumbnailHold.trustedEvents), 1)
      await page.evaluate(() => window.catalogThumbnailHold.release())
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
    assert.equal(await page.evaluate(() => window.catalogThumbnailHold.trustedEvents), 2)
    await page.evaluate(() => window.catalogThumbnailHold.release())
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

  await t.test('queued arrow presses advance through the visible order and stop at its ends', async (t) => {
    const thirdPalette = [colors[1], colors[2], colors[3], colors[0]]
    const { page, run, first, second } = await workspace(t, [...originals, fixture(thirdPalette)])
    const sorted = await run('sort', { order: 'name' })
    const third = sorted.photos.find(({ name }) => name === '2.png').id
    await page.evaluate(() => {
      window.navigationChanges = []
      const filename = document.getElementById('filename')
      window.addEventListener('openlr-change', () => window.navigationChanges.push(filename.textContent))
    })
    await holdThumbnail(page, 'body', 'keydown')
    await queuePhotoChange(page)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.evaluate(() => window.catalogThumbnailHold.trustedEvents), 2)
    await page.evaluate(() => window.catalogThumbnailHold.release())
    assert.equal((await run('state')).selected, third)
    assert.deepEqual(await page.evaluate(() => window.navigationChanges), ['0.png', '1.png', '2.png'])
    assert.deepEqual(await image(page, 'preview'), { width, height, samples: thirdPalette })

    await run('straighten-tool', { axis: 'horizontal' })
    const count = await page.evaluate(() => window.navigationChanges.length)
    await page.keyboard.press('ArrowRight')
    const atEnd = await run('select-relative', { direction: 'next' })
    assert.equal(atEnd.selected, third)
    assert.equal(atEnd.straightenTool.axis, 'horizontal')
    assert.equal(await page.evaluate(() => window.navigationChanges.length), count)
    const previous = await run('select-relative', { direction: 'previous' })
    assert.equal(previous.selected, second)
    assert.equal(previous.straightenTool.axis, 'off')
    await page.keyboard.press('ArrowLeft')
    assert.equal((await run('state')).selected, first)
    assert.equal((await run('select-relative', { direction: 'previous' })).selected, first)

    await run('rate', { value: 4, advance: false })
    await run('select', { id: third })
    await run('rate', { value: 4, advance: false })
    await run('filter', { rating: 4 })
    await run('select', { id: first })
    assert.equal((await run('select-relative', { direction: 'next' })).selected, third)
  })

  await t.test(
    'queued video controls use the current playback state and reject a switched clip',
    async (t) => {
      const { page, run } = await openWorkspace(t)
      const buffer = await makeVideoFixture(page)
      await page
        .locator('#files')
        .setInputFiles({ name: 'three-colors.webm', mimeType: 'video/webm', buffer })
      await page.waitForFunction(() => document.querySelectorAll('#gallery .tile').length === 1)
      const first = (await run('state')).selected
      await run('video-seek', { time: 0.35 })
      await page.evaluate(() => {
        window.videoControlCalls = []
        for (const method of ['play', 'pause']) {
          const original = HTMLMediaElement.prototype[method]
          HTMLMediaElement.prototype[method] = function (...args) {
            window.videoControlCalls.push([method, this.paused])
            return original.apply(this, args)
          }
        }
      })
      const button = page.locator('#play-video')
      await holdThumbnail(page, '#play-video', 'click')
      await queuePhotoChange(page)
      await button.click()
      await button.click()
      assert.equal(await page.evaluate(() => window.catalogThumbnailHold.trustedEvents), 2)
      await page.evaluate(() => window.catalogThumbnailHold.release())
      const paused = (await run('state')).playback
      assert.equal(paused.playing, false)
      assert.ok(paused.time >= 0.35)
      assert.deepEqual(await page.evaluate(() => window.videoControlCalls), [
        ['play', true],
        ['pause', false]
      ])
      assert.equal(await button.textContent(), 'Play')
      await expectVideoColor(page, Math.min(2, Math.floor(paused.time)))

      const second = (await run('virtual-copy')).selected
      const copiedEdit = { Contrast: 20 }
      await run('select', { id: first })
      await run('video-seek', { time: 0.35 })
      await holdThumbnail(page, '#play-video', 'click')
      await queuePhotoChange(page, second)
      await button.click()
      assert.equal(await page.evaluate(() => window.catalogThumbnailHold.trustedEvents), 1)
      await page.evaluate(() => window.catalogThumbnailHold.release())
      const switched = await run('state')
      assert.equal(switched.selected, second)
      assert.equal(switched.playback.playing, false)
      assert.match(await page.locator('#notice').textContent(), /selected photo changed/i)
      await assert.rejects(() => run('video-toggle', { photoId: first }), /selected photo changed/i)
      assert.equal((await run('video-toggle', { photoId: second })).playback.playing, true)
      assert.equal((await run('video-pause')).playback.playing, false)

      const position = page.locator('#video-position')
      async function applyTrim() {
        await page.locator('#trim-start').fill('1.1')
        await page.locator('#trim-end').fill('2.6')
        await page.locator('#trim-apply').click()
      }
      for (const [control, type, act] of [
        ['#video-position', 'change', () => position.press('ArrowRight')],
        ['#trim-apply', 'click', applyTrim]
      ]) {
        await run('select', { id: first })
        await run('video-seek', { time: 0.35 })
        await holdThumbnail(page, control, type)
        await queuePhotoChange(page, second)
        await act()
        assert.equal(await page.evaluate(() => window.catalogThumbnailHold.trustedEvents), 1)
        await page.evaluate(() => window.catalogThumbnailHold.release())
        const after = await run('state')
        assert.equal(after.selected, second)
        assert.equal(after.playback.time, 0)
        assert.deepEqual(editOf(after, first), { Contrast: 20 })
        assert.deepEqual(editOf(after, second), copiedEdit)
        assert.match(await page.locator('#notice').textContent(), /selected photo changed/i)
      }
      await assert.rejects(() => run('video-seek', { time: 2.35, photoId: first }), /selected photo changed/i)
      await assert.rejects(
        () => run('video-trim', { start: 1.1, end: 2.6, photoId: first }),
        /selected photo changed/i
      )
      await run('video-seek', { time: 2.34, photoId: second })
      await position.press('ArrowRight')
      assert.ok(Math.abs((await run('state')).playback.time - 2.35) < 1e-5)
      await expectVideoColor(page, 2)
      await applyTrim()
      const trimmed = await run('state')
      assert.deepEqual(editOf(trimmed), { ...copiedEdit, trim: { start: 1.1, end: 2.6 } })
      assert.ok(Math.abs(trimmed.playback.time - 1.1) < 1e-5)
      await expectVideoColor(page, 1)
      assert.deepEqual(editOf(await run('undo')), copiedEdit)
    }
  )
})
