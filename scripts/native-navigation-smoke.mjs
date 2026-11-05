import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { makePng } from '../tests/fixtures/png.mjs'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const defaults = { autoAdvance: false, filenames: true, extensions: true, shortcuts: true }
const windows = process.platform === 'win32'
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
  async ({ root, call, restart, initial, profile }) => {
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

    if (windows) {
      const reopened = await restart()
      assert.deepEqual(photo(reopened).edit, edit)
      assert.equal(photo(reopened).rating, 3)
      assert.deepEqual(await call('preferences'), disabled)
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
        fullscreen: fullScreen || 'Windows check',
        preferenceRestartAndKeyboard: windows,
        preservedOriginals: fixtures.length
      })
    )
  },
  {
    persistent: windows,
    env: windows
      ? {
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
            '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1'
        }
      : {}
  }
)
