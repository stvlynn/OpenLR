import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { watch } from '../cli/openlr.mjs'
import { makePng } from '../tests/fixtures/png.mjs'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const defaults = { autoAdvance: false, filenames: true, extensions: true, shortcuts: true }
const windows = process.platform === 'win32'
const persistent = windows || process.platform === 'linux'
const dimensions = ({ width, height }) => [width, height]
function centerRgb({ width, height, data }) {
  const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
  return Array.from(data.subarray(offset, offset + 3), (value) => Math.round(value * 255))
}

function assertSolidHistogram(bins, [red, green, blue]) {
  const luma = Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue)
  const count = bins.red[red]
  assert.ok(Number.isSafeInteger(count) && count > 0, 'The RGB peak should contain rendered pixels')
  for (const [channel, peak] of Object.entries({ red, green, blue, luma })) {
    const expected = Array(256).fill(0)
    expected[peak] = count
    assert.deepEqual(bins[channel], expected, `${channel} should peak at ${peak}`)
  }
  return count
}

// Find contiguous rectangular patches in the fixture's uniform color. Pixels
// in the surrounding UI can match the color without belonging to a photo.
function colorPatchBounds({ width, height, data }, rgb, [patchWidth, patchHeight]) {
  const [red, green, blue] = rgb.map((value) => value / 255)
  const tolerance = 5 / 255
  const columnHeights = new Uint32Array(width)
  let left = width,
    right = -1,
    top = height,
    bottom = -1
  for (let y = 0; y < height; y++) {
    let runWidth = 0
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      const matches =
        Math.abs(data[offset] - red) <= tolerance &&
        Math.abs(data[offset + 1] - green) <= tolerance &&
        Math.abs(data[offset + 2] - blue) <= tolerance
      columnHeights[x] = matches ? columnHeights[x] + 1 : 0
      runWidth = columnHeights[x] >= patchHeight ? runWidth + 1 : 0
      if (runWidth < patchWidth) continue
      left = Math.min(left, x + 1 - runWidth)
      right = Math.max(right, x)
      top = Math.min(top, y + 1 - patchHeight)
      bottom = y
    }
  }
  return right < 0 ? null : { left, right, top, bottom }
}

function countPixels({ width, data }, { left, right, top, bottom }, matches) {
  let count = 0
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      if (matches(data, (y * width + x) * 4)) count++
    }
  }
  return count
}

async function inspectWebView(profile, inspect) {
  // Only the disposable test WebView opts in. Port 0 avoids opening a fixed port,
  // and the endpoint is discovered from this run's private profile.
  const endpoint = await readFile(path.join(profile, 'EBWebView', 'DevToolsActivePort'), 'utf8')
  const port = Number(endpoint.split(/\r?\n/)[0])
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535)
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 })
  try {
    const pages = browser.contexts().flatMap((context) => context.pages())
    const page = pages.find((candidate) => candidate.url() === 'http://mygo.localhost/')
    assert.ok(page, 'Expected the OpenLR page from the private WebView2')
    return await inspect(page)
  } finally {
    await browser.close()
  }
}

function visiblePanelItems(profile, selector, items) {
  return inspectWebView(profile, (page) =>
    page.locator(selector).evaluate((panel, items) => {
      const bounds = panel.getBoundingClientRect()
      return Object.fromEntries(
        items.map((item) => {
          const rect = panel.querySelector(item)?.getBoundingClientRect()
          return [item, Boolean(rect?.height && rect.bottom > bounds.top && rect.top < bounds.bottom)]
        })
      )
    }, items)
  )
}

async function gridLabels(page) {
  return page.locator('#gallery .tile span').evaluateAll((labels) =>
    labels.map((label) => ({
      name: label.textContent,
      visible: label.getBoundingClientRect().height > 0 && getComputedStyle(label).visibility === 'visible'
    }))
  )
}

async function pressFilmShortcut(page) {
  await page.locator('#heading').click()
  await page.evaluate(() => {
    document.documentElement.removeAttribute('data-test-film-key')
    document.addEventListener(
      'keydown',
      (event) => {
        document.documentElement.dataset.testFilmKey = `${event.key}:${event.isTrusted}`
      },
      { once: true, capture: true }
    )
  })
  await page.keyboard.press('Slash')
  assert.equal(await page.locator('html').getAttribute('data-test-film-key'), '/:true')
}

await withNativeWorkspace(
  process.argv[2],
  async ({ root, call, restart, initial, profile, session }) => {
    const capture = async (name, ...args) => {
      const output = path.join(root, name + '.png')
      const response = args.length
        ? await call(...args, '--capture', output)
        : await call('screenshot', '--output', output)
      assert.equal((response.frame ?? response).mimeType, 'image/png')
      return { image: readPng(await readFile(output)), result: response.result }
    }
    const state = () => call('state')
    const prefs = (values) => call('preferences', '--args', JSON.stringify(values))
    const view = (mode) => call('view', '--mode', mode, '--inspector', 'false')
    const edit = { Exposure: 1 }
    const width = 120,
      height = 80
    // A quarter of each fixture dimension fits inside its filmstrip thumbnail.
    const patchSize = [width / 4, height / 4]
    const photoPatch = (image, rgb) => colorPatchBounds(image, rgb, patchSize)
    const fixtures = [
      { name: 'ridge.png', rgb: [51, 82, 115] },
      { name: 'summit.png', rgb: [179, 46, 111] }
    ].map(({ name, rgb }) => ({
      name,
      rgb,
      file: path.join(root, name),
      bytes: Buffer.from(
        makePng({
          width,
          height,
          bits: 8,
          data: Array(width * height)
            .fill(rgb)
            .flat()
        })
      )
    }))
    assert.deepEqual(initial.photos, [])
    assert.deepEqual(await call('preferences'), defaults)
    for (const { file, bytes } of fixtures) await writeFile(file, bytes)
    const { added, failed } = await call('import', ...fixtures.map(({ file }) => file))
    assert.deepEqual(failed, [])
    assert.equal(added.length, fixtures.length)
    const [first, second] = added
    const select = (id) => call('select', '--id', id)
    const photo = (snapshot) => snapshot.photos.find(({ id }) => id === first)
    await call('sort', '--order', 'name', '--direction', 'asc')
    await select(first)
    assert.equal((await call('select-relative', '--direction', 'next')).selected, second)
    const nextPreview = await call('preview', '--output', path.join(root, 'relative-next.png'))
    assert.deepEqual(centerRgb(readPng(await readFile(nextPreview.path))), fixtures[1].rgb)
    assert.equal((await call('select-relative', '--direction', 'next')).selected, second)
    assert.equal((await call('select-relative', '--direction', 'previous')).selected, first)
    assert.equal((await call('select-relative', '--direction', 'previous')).selected, first)
    await call('rate', '--value', '3')
    await call('edit', '--key', 'Exposure', '--value', String(edit.Exposure))
    const saved = await view('detail')
    const exported = await call('export', '--format', 'image/png', '--output', path.join(root, 'edited.png'))
    const editedRgb = centerRgb(readPng(await readFile(exported.path)))
    const originalRgb = fixtures[0].rgb
    assert.ok(editedRgb.every((value, channel) => value > originalRgb[channel] + 12))
    const committedBins = await call('histogram')
    const committedCount = assertSolidHistogram(committedBins, editedRgb)
    assert.equal(committedCount, width * height)
    const displayBins = () => call('histogram', '--source', 'display')

    assert.equal(saved.film, true)
    const hidden = await capture('film-hidden', 'film')
    const shown = await capture('film-shown', 'film')
    assert.equal(hidden.result.film, false)
    assert.equal(shown.result.film, true)
    assert.equal((await state()).film, true)
    assert.deepEqual(dimensions(hidden.image), dimensions(shown.image))
    const hiddenThumb = photoPatch(hidden.image, fixtures[1].rgb)
    const shownThumb = photoPatch(shown.image, fixtures[1].rgb)
    assert.equal(hiddenThumb, null)
    assert.ok(shownThumb && shownThumb.top > shown.image.height * 0.65, JSON.stringify(shownThumb))

    await call('film')
    assert.equal((await call('compare')).compare, true)
    const originalCount = assertSolidHistogram(await displayBins(), originalRgb)
    assert.deepEqual(await call('histogram'), committedBins)
    const paired = await capture('comparison-pair', 'compare-pair')
    assert.equal(paired.result.mode, 'detail')
    assert.equal(paired.result.pair, true)
    assert.equal(paired.result.compare, false)
    assert.equal((await state()).pair, true)
    const pairCount = assertSolidHistogram(await displayBins(), editedRgb)
    assert.deepEqual(await call('histogram', '--source', 'edited'), committedBins)
    const left = photoPatch(paired.image, originalRgb)
    const right = photoPatch(paired.image, editedRgb)
    assert.ok(left && right && left.right < right.left, JSON.stringify({ left, right }))
    const single = await capture('comparison-closed', 'compare-pair')
    assert.equal(single.result.pair, false)
    const closedOriginal = photoPatch(single.image, originalRgb)
    const singleEdit = photoPatch(single.image, editedRgb)
    assert.equal(closedOriginal, null)
    assert.ok(singleEdit, 'Expected the edited photo after closing Compare Pair')
    await call('film')

    const fullScreen =
      windows &&
      (await inspectWebView(profile, async (page) => {
        const viewport = () => page.evaluate(() => [innerWidth, innerHeight])
        const normalViewport = await viewport()
        const normal = dimensions((await capture('normal-window')).image)
        await call('fullscreen')
        await page.waitForFunction(
          () =>
            !document.fullscreenElement &&
            Math.abs(innerWidth - screen.width) <= 2 &&
            Math.abs(innerHeight - screen.height) <= 2,
          undefined,
          { timeout: 5000 }
        )
        const full = dimensions((await capture('fullscreen-window')).image)
        assert.notDeepEqual(full, normal, 'Fullscreen should resize the actual captured WebView')
        await call('fullscreen')
        await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, normalViewport, {
          timeout: 5000
        })
        const restored = dimensions((await capture('restored-window')).image)
        assert.deepEqual(restored, normal)
        return { normal, full, restored }
      }))

    await view('grid')
    await assert.rejects(displayBins, /Wait for the photo preview in Detail/)
    assert.deepEqual(await call('histogram'), committedBins)
    const shortened = { ...defaults, extensions: false }
    const disabled = { ...shortened, filenames: false, shortcuts: false }
    const names = (suffix, visible) =>
      fixtures.map(({ name }) => ({
        name: suffix ? name : path.parse(name).name,
        visible
      }))
    if (windows) {
      await inspectWebView(profile, async (page) => {
        assert.deepEqual(await gridLabels(page), names(true, true))
        assert.deepEqual(await prefs({ extensions: false }), shortened)
        assert.deepEqual(await gridLabels(page), names(false, true))
        assert.deepEqual(await prefs({ filenames: false, shortcuts: false }), disabled)
        assert.deepEqual(await gridLabels(page), names(false, false))
      })
    } else {
      assert.deepEqual(await prefs(disabled), disabled)
    }
    assert.deepEqual(await call('preferences'), disabled)
    assert.deepEqual((await state()).photos, saved.photos)

    // A known edit and a separate library entry must remain at the top of their histories.
    await view('detail')
    assert.deepEqual(photo(await call('history-undo')).edit, {})
    assert.deepEqual(photo(await call('history-redo')).edit, edit)
    assert.equal(photo(await call('library-undo')).rating, 0)
    assert.equal(photo(await call('library-redo')).rating, 3)

    if (persistent) {
      const reopened = await restart()
      assert.deepEqual(photo(reopened).edit, edit)
      assert.equal(photo(reopened).rating, 3)
      assert.deepEqual(await call('preferences'), disabled)
    }
    if (windows) {
      await call('sort', '--order', 'name', '--direction', 'asc')
      await inspectWebView(profile, async (page) => {
        assert.deepEqual(await gridLabels(page), names(false, false))
        await select(first)
        await view('detail')
        assert.equal((await state()).film, true)
        await pressFilmShortcut(page)
        assert.equal((await state()).film, true)
        assert.equal(await page.locator('#film').isVisible(), true)
        assert.equal((await call('film')).film, false)
        assert.equal((await call('film')).film, true)
        assert.deepEqual(await prefs(defaults), defaults)
        await pressFilmShortcut(page)
        await page.locator('#film').waitFor({ state: 'hidden', timeout: 5000 })
        assert.equal((await state()).film, false)
      })
    } else {
      assert.deepEqual(await prefs(defaults), defaults)
    }
    assert.deepEqual(photo(await state()).edit, edit)

    // Wide mosaic tiles provide real vertical overflow. Two bands wider than
    // the window also provide distinct first/last visible Filmstrip thumbnails.
    const catalogColors = [
      [232, 156, 39],
      [37, 170, 133]
    ]
    const catalogSources = catalogColors.map((rgb) =>
      Buffer.from(
        makePng({
          width: 120,
          height: 40,
          bits: 8,
          data: Array(120 * 40)
            .fill(rgb)
            .flat()
        })
      )
    )
    const viewport = (target, ...args) => call('viewport', '--target', target, ...args)
    await view('detail')
    if (!(await state()).film) await call('film')
    const filmWidth = (await viewport('filmstrip')).width
    await view('grid')
    await call('grid-layout', '--layout', 'mosaic')
    const gridSize = await viewport('grid')
    // Each 3:1 source makes a 420px mosaic tile and the film tile is at
    // least 78px wide. Size the bands to the actual disposable window.
    const bandSize = Math.max(
      18,
      Math.ceil(filmWidth / 78) + 1,
      Math.floor(gridSize.width / 420) * Math.ceil(gridSize.height / 152) + 1
    )
    const catalogFiles = Array.from({ length: 2 * bandSize }, (_, i) => ({
      file: path.join(root, `viewport-${String(i).padStart(2, '0')}.png`),
      bytes: catalogSources[Math.floor(i / bandSize)]
    }))
    await Promise.all(catalogFiles.map(({ file, bytes }) => writeFile(file, bytes)))
    const catalogImport = await call('import', ...catalogFiles.map(({ file }) => file))
    assert.deepEqual(catalogImport.failed, [])
    assert.equal(catalogImport.added.length, catalogFiles.length)
    await call('sort', '--order', 'name', '--direction', 'asc')
    await select(first)
    const catalogPatch = (image, color) => colorPatchBounds(image, color, [24, 12])
    async function visibleBand(name, color, initialCapture) {
      // Lazy thumbnails may decode just after the command's ordered capture.
      // Wait for the expected visible pixels without moving the viewport again.
      const deadline = performance.now() + 5000
      let image = initialCapture,
        attempt = 0
      do {
        image ??= (await capture(`${name}-${attempt++}`)).image
        const patch = catalogPatch(image, color)
        if (patch) return { image, patch }
        image = undefined
        await delay(50)
      } while (performance.now() < deadline)
      assert.fail(`Expected the visible ${name} thumbnail band`)
    }
    async function verifyViewportScroll(target, axis, key, inspectCapture) {
      const extent = axis === 'y' ? 'maxY' : 'maxX'
      const otherAxis = axis === 'y' ? 'x' : 'y'
      const top = await viewport(target, '--' + axis, '0', '--photoId', first)
      assert.equal(top[axis], 0)
      assert.ok(top[extent] > 0, `Expected the ${target} fixture to overflow`)
      const start = await inspectCapture((await capture(`${target}-start`)).image, false)
      const before = await state()
      assert.deepEqual(before[key][target], top)
      assert.equal(before.selected, first)
      let scrolled, revision
      await Promise.race([
        watch({ session, count: 2 }, async (update) => {
          assert.equal(update.selected, first)
          if (revision !== undefined) {
            assert.equal(update.revision, revision + 1, 'Only the actual scroll publishes a revision')
            assert.deepEqual(update[key][target], scrolled.result)
            return
          }
          revision = update.revision
          assert.deepEqual(update[key][target], top)
          assert.deepEqual(await viewport(target), top)
          assert.deepEqual(await viewport(target, '--' + axis, '0'), top)
          await assert.rejects(
            viewport(target, '--' + axis, '10', '--photoId', second),
            /selected photo changed/
          )
          scrolled = await capture(
            `${target}-end-command`,
            'viewport',
            '--target',
            target,
            '--' + axis,
            String(top[extent] + 1000),
            '--photoId',
            first
          )
          assert.ok(Math.abs(scrolled.result[axis] - top[extent]) <= 1, 'Move clamps to the browser endpoint')
          assert.equal(scrolled.result[otherAxis], top[otherAxis])
        }),
        delay(15_000, undefined, { ref: false }).then(() => {
          throw Error(`No observed ${target} scroll`)
        })
      ])
      const end = await inspectCapture(scrolled.image, true)
      assert.deepEqual(dimensions(end.image), dimensions(start.image))
      const after = await state()
      assert.deepEqual(after[key][target], scrolled.result)
      assert.deepEqual(await viewport(target), scrolled.result)
      for (const group of ['catalogViewports', 'panelViewports']) {
        const readback = group === key ? { ...after[group], [target]: top } : after[group]
        assert.deepEqual(readback, before[group])
      }
      assert.deepEqual(after.viewport, before.viewport)
      assert.deepEqual(after.photos, before.photos)
      assert.deepEqual(after.selection, before.selection)
      assert.equal(after.selected, first)
      return { start, end, range: { start: top[axis], end: scrolled.result[axis], extent: top[extent] } }
    }
    async function verifyCatalogScroll(target, axis) {
      const { start, end, range } = await verifyViewportScroll(
        target,
        axis,
        'catalogViewports',
        async (image, end) => {
          const captured = await visibleBand(
            `${target}-${end ? 'end' : 'start'}`,
            catalogColors[Number(end)],
            image
          )
          assert.equal(catalogPatch(captured.image, catalogColors[Number(!end)]), null)
          if (target === 'filmstrip') assert.ok(captured.patch.top > captured.image.height * 0.65)
          return captured
        }
      )
      return { ...range, capturedBands: [start.patch, end.patch] }
    }
    async function rejectHiddenViewport(target, axis, key, error) {
      const before = await state()
      assert.equal(before[key][target], null)
      await assert.rejects(viewport(target, '--' + axis, '10'), error)
      const after = await state()
      assert.deepEqual(after.catalogViewports, before.catalogViewports)
      assert.deepEqual(after.panelViewports, before.panelViewports)
      assert.deepEqual(after.viewport, before.viewport)
    }

    await view('grid')
    await rejectHiddenViewport('filmstrip', 'x', 'catalogViewports', /Show the filmstrip in detail view/)
    const gridScroll = await verifyCatalogScroll('grid', 'y')
    await view('detail')
    assert.deepEqual(await call('viewport'), await viewport('detail'))
    await rejectHiddenViewport('grid', 'y', 'catalogViewports', /Open Grid view/)
    if (!(await state()).film) await call('film')
    const filmScroll = await verifyCatalogScroll('filmstrip', 'x')
    await call('film')
    await rejectHiddenViewport('filmstrip', 'x', 'catalogViewports', /Show the filmstrip in detail view/)

    const hiddenPhotos = /Show the Photos panel/
    const hiddenInspector = /Show the Inspector in detail view/
    await call('panel', '--name', 'photos', '--open', 'false')
    await rejectHiddenViewport('photos', 'y', 'panelViewports', hiddenPhotos)
    await call('panel', '--name', 'photos', '--open', 'true')
    await view('grid')
    await rejectHiddenViewport('inspector', 'y', 'panelViewports', hiddenInspector)
    assert.deepEqual((await state()).panelViewports.photos, await viewport('photos'))
    await call('view', '--mode', 'detail', '--inspector', 'true')
    await call('panel', '--name', 'Histogram', '--open', 'true')
    await call('panel', '--name', 'Info', '--open', 'true')

    const layout = await state()
    const { photos: photosSize, inspector: inspectorSize } = layout.panelViewports
    const bandRows = Math.ceil(photosSize.height / 32) + 1
    const albums = []
    for (let i = 0; i < 2 * bandRows; i++) {
      const label = i < bandRows ? 'I' : 'MMMMMMMMMM'
      albums.push(await call('album', '--name', `${label} ${i + 1}`))
    }
    // Widths are CSS pixels. Estimate the capture scale from the three client
    // widths and stay well inside each panel to exclude its scrollbar/edge.
    const panelScale = (image) =>
      image.width / (photosSize.width + layout.viewport.width + inspectorSize.width)
    const verticalBand = (image) => ({
      top: Math.floor(image.height * 0.22),
      bottom: Math.floor(image.height * 0.78)
    })
    const albumMarkers = [albums[0], albums.at(-1)].map(({ id }) => `[data-scope="${id}"]`)
    const photosScroll = await verifyViewportScroll('photos', 'y', 'panelViewports', async (image, end) => {
      if (windows) {
        assert.deepEqual(await visiblePanelItems(profile, 'nav', albumMarkers), {
          [albumMarkers[0]]: !end,
          [albumMarkers[1]]: end
        })
      }
      const width = photosSize.width * panelScale(image)
      const ink = countPixels(
        image,
        { left: Math.floor(width * 0.45), right: Math.floor(width * 0.72), ...verticalBand(image) },
        (data, offset) => Math.min(data[offset], data[offset + 1], data[offset + 2]) > 0.55
      )
      return { image, ink }
    })
    assert.ok(
      photosScroll.end.ink > Math.max(300, photosScroll.start.ink * 2),
      `Wide endpoint album labels must add visible glyph ink (${photosScroll.start.ink} → ${photosScroll.end.ink})`
    )

    const inspectorScroll = await verifyViewportScroll(
      'inspector',
      'y',
      'panelViewports',
      async (image, end) => {
        if (windows) {
          assert.deepEqual(await visiblePanelItems(profile, 'aside', ['#histogram', '#keywords']), {
            '#histogram': !end,
            '#keywords': end
          })
        }
        return { image }
      }
    )
    const inspectorWidth = inspectorSize.width * panelScale(inspectorScroll.end.image)
    const inspectorChangedPixels = countPixels(
      inspectorScroll.end.image,
      {
        left: Math.floor(inspectorScroll.end.image.width - inspectorWidth * 0.85),
        right: Math.floor(inspectorScroll.end.image.width - inspectorWidth * 0.16),
        ...verticalBand(inspectorScroll.end.image)
      },
      (data, offset) =>
        [0, 1, 2].some(
          (channel) =>
            Math.abs(data[offset + channel] - inspectorScroll.start.image.data[offset + channel]) > 0.1
        )
    )
    assert.ok(
      inspectorChangedPixels > 1000,
      `Expected different Inspector controls (${inspectorChangedPixels} pixels)`
    )

    await call('slideshow', '--seconds', '3600')
    assert.equal((await state()).slideshow, true)
    await rejectHiddenViewport('photos', 'y', 'panelViewports', hiddenPhotos)
    await rejectHiddenViewport('inspector', 'y', 'panelViewports', hiddenInspector)
    await call('slideshow', '--stop', 'true')
    const restored = await state()
    assert.deepEqual(restored.panelViewports.photos, await viewport('photos'))
    assert.deepEqual(restored.panelViewports.inspector, await viewport('inspector'))
    assert.equal((await state()).selected, first)
    assert.deepEqual(photo(await state()).edit, edit)
    for (const { file, bytes } of catalogFiles) assert.deepEqual(await readFile(file), bytes)

    for (const [index, id] of [first, second].entries()) {
      const { file, bytes } = fixtures[index]
      await select(id)
      const output = await call(
        'export',
        '--format',
        'original',
        '--output',
        path.join(root, `original-${index}.png`)
      )
      assert.deepEqual(await readFile(output.path), bytes)
      assert.deepEqual(await readFile(file), bytes)
    }
    console.log(
      JSON.stringify({
        nativeNavigation: 'passed',
        filmThumbnailBounds: { shown: shownThumb, hidden: hiddenThumb },
        compareRgb: { original: originalRgb, edited: editedRgb },
        compareBounds: { left, right, closedOriginal, singleEdit },
        histogramPeakCounts: {
          committed: committedCount,
          displayOriginal: originalCount,
          displayPair: pairCount
        },
        fullscreen: fullScreen || null,
        catalogScroll: {
          grid: gridScroll,
          filmstrip: filmScroll,
          unchangedFixtureFiles: catalogFiles.length
        },
        panelScroll: {
          photos: {
            ...photosScroll.range,
            albumCount: albums.length,
            glyphInkPixels: [photosScroll.start.ink, photosScroll.end.ink]
          },
          inspector: { ...inspectorScroll.range, changedControlPixels: inspectorChangedPixels },
          namedVisibleItems: windows
        },
        preferenceRestart: persistent,
        trustedKeyboard: windows,
        preservedOriginals: fixtures.length
      })
    )
  },
  {
    persistent,
    env: windows
      ? {
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
            '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1'
        }
      : {}
  }
)
