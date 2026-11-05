import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeExportSettings, loadExportSettings, saveExportSettings } from '../web/export-settings.js'

function storageFixture(initial = {}) {
  const values = new Map(Object.entries(initial)),
    writes = []
  return {
    values,
    writes,
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      writes.push([key, value])
      values.set(key, value)
    }
  }
}

test('export settings resolve existing format defaults and preserve only effective options', () => {
  assert.deepEqual(normalizeExportSettings({}, 'photo'), {
    format: 'image/jpeg',
    quality: 0.92,
    colorSpace: 'srgb'
  })
  assert.deepEqual(normalizeExportSettings({}, 'video'), { format: 'video/mp4' })
  for (const format of ['image/jpeg', 'image/avif', 'image/jxl']) {
    assert.deepEqual(normalizeExportSettings({ format, quality: 0, colorSpace: 'display-p3' }, 'photo'), {
      format,
      quality: 0,
      colorSpace: 'display-p3'
    })
    assert.equal(normalizeExportSettings({ format }, 'video').quality, 0.92)
  }
  for (const format of ['image/png', 'image/tiff', 'video/mp4', 'video/webm']) {
    const expected = {
      format,
      ...(format.startsWith('image/') ? { colorSpace: 'srgb' } : {}),
      maxSize: 31,
      watermark: ' OpenLR '
    }
    assert.deepEqual(
      normalizeExportSettings({ format, quality: 0.3, maxSize: 31, watermark: ' OpenLR ' }, 'video'),
      expected
    )
  }
  for (const format of ['original', 'original-settings', 'application/rdf+xml'])
    assert.deepEqual(
      normalizeExportSettings({ format, quality: 0.3, maxSize: 31, watermark: 'Ignored' }, 'photo'),
      { format }
    )
  assert.deepEqual(
    normalizeExportSettings({ format: 'image/x-adobe-dng', quality: 0.3, watermark: '' }, 'photo'),
    { format: 'image/x-adobe-dng' }
  )
  assert.deepEqual(normalizeExportSettings({ format: 'image/png', watermark: '' }, 'photo'), {
    format: 'image/png',
    colorSpace: 'srgb'
  })
})

test('normalization uses the shared export validator and actual media boundaries', () => {
  for (const options of [
    null,
    [],
    'png',
    { format: 'image/gif' },
    { quality: 1.1 },
    { quality: NaN },
    { maxSize: 0 },
    { maxSize: 1.5 },
    { maxSize: Number.MAX_SAFE_INTEGER + 1 },
    { colorSpace: 'unknown' },
    { format: 'original', colorSpace: 'srgb' },
    { filename: 'ignored.png' }
  ])
    assert.throws(() => normalizeExportSettings(options, 'photo'))
  assert.throws(() => normalizeExportSettings({}, 'still'), /photo or video/)
  assert.throws(() => normalizeExportSettings({ format: 'video/webm' }, 'photo'), /Select a video/)
  assert.throws(() => normalizeExportSettings({ colorSpace: 'srgb' }, 'video'), /color space/)
  for (const options of [{ maxSize: 31 }, { watermark: 'Mark' }])
    assert.throws(
      () => normalizeExportSettings({ format: 'image/x-adobe-dng', ...options }, 'photo'),
      /RAW pixels/
    )
  const input = { format: 'image/png', quality: 0.5, colorSpace: 'prophoto-rgb', maxSize: 31 }
  const before = structuredClone(input)
  assert.notEqual(normalizeExportSettings(input, 'video'), input)
  assert.deepEqual(input, before)
})

test('loading strict persisted media slots never writes and isolates malformed records', () => {
  for (const invalid of [
    '{',
    'null',
    '[]',
    '"png"',
    '{}',
    '{"photo":{}}',
    '{"photo":{"format":"bad"}}',
    '{"photo":{"format":"image/png","maxSize":0}}',
    '{"photo":{"format":"image/png","unknown":1}}'
  ]) {
    const storage = storageFixture({ 'export-settings': invalid })
    assert.deepEqual(loadExportSettings(storage), { photo: null, video: null })
    assert.equal(storage.writes.length, 0)
  }
  const storage = storageFixture({
    'export-settings': JSON.stringify({
      photo: { format: 'image/png', quality: 0.5 },
      video: { format: 'video/webm', colorSpace: 'srgb' }
    })
  })
  assert.deepEqual(loadExportSettings(storage), {
    photo: { format: 'image/png', colorSpace: 'srgb' },
    video: null
  })
  assert.equal(storage.writes.length, 0)
})

test('legacy flat settings apply to compatible media unless a new slot explicitly overrides them', () => {
  const storage = storageFixture({
      'last-export': JSON.stringify({
        format: 'image/png',
        quality: 0.7,
        maxSize: 31,
        colorSpace: 'display-p3'
      })
    }),
    expected = { format: 'image/png', maxSize: 31, colorSpace: 'display-p3' }
  assert.deepEqual(loadExportSettings(storage), { photo: expected, video: expected })
  storage.values.set('export-settings', JSON.stringify({ photo: null }))
  assert.deepEqual(loadExportSettings(storage), { photo: null, video: expected })
  storage.values.set('export-settings', JSON.stringify({ photo: { format: 'bad' } }))
  assert.deepEqual(loadExportSettings(storage), { photo: null, video: expected })
  storage.values.delete('export-settings')
  storage.values.set('last-export', JSON.stringify({ format: 'video/webm', maxSize: 80 }))
  assert.deepEqual(loadExportSettings(storage), { photo: null, video: { format: 'video/webm', maxSize: 80 } })
  for (const invalid of ['{', '[]', '{}', '{"format":"original","colorSpace":"srgb"}']) {
    storage.values.set('last-export', invalid)
    assert.deepEqual(loadExportSettings(storage), { photo: null, video: null })
  }
  assert.equal(storage.writes.length, 0)
})

test('successful saves commit captured media options once and retain independent settings across restart', () => {
  const storage = storageFixture({ 'last-export': JSON.stringify({ format: 'image/png' }) }),
    captured = {
      media: 'photo',
      options: {
        format: 'image/tiff',
        colorSpace: 'prophoto-rgb',
        quality: 0.4,
        maxSize: 123,
        watermark: 'OpenLR'
      }
    },
    saved = saveExportSettings(captured, storage)
  assert.deepEqual(saved, {
    photo: { format: 'image/tiff', colorSpace: 'prophoto-rgb', maxSize: 123, watermark: 'OpenLR' },
    video: { format: 'image/png', colorSpace: 'srgb' }
  })
  assert.equal(storage.writes.length, 1)
  assert.equal(storage.values.get('last-export'), JSON.stringify({ format: 'image/png' }))
  captured.options.maxSize = 999
  saved.photo.maxSize = 456
  assert.equal(loadExportSettings(storage).photo.maxSize, 123)
  const next = saveExportSettings({ media: 'video', options: { format: 'video/webm', maxSize: 64 } }, storage)
  assert.equal(next.photo.maxSize, 123)
  assert.deepEqual(next.video, { format: 'video/webm', maxSize: 64 })
  assert.deepEqual(loadExportSettings(storageFixture(Object.fromEntries(storage.values))), next)
})

test('invalid input and storage failures do not replace previously remembered settings', () => {
  const storage = storageFixture({
      'export-settings': JSON.stringify({ photo: { format: 'image/png' }, video: null })
    }),
    original = storage.values.get('export-settings')
  assert.throws(() => saveExportSettings({ media: 'photo', options: { format: 'video/mp4' } }, storage))
  assert.equal(storage.writes.length, 0)
  const denied = Error('Storage access denied')
  assert.throws(
    () =>
      loadExportSettings({
        getItem() {
          throw denied
        }
      }),
    (error) => error === denied
  )
  assert.throws(
    () =>
      saveExportSettings(
        { media: 'photo', options: {} },
        {
          getItem() {
            throw denied
          }
        }
      ),
    (error) => error === denied
  )
  storage.setItem = () => {
    throw denied
  }
  assert.throws(
    () => saveExportSettings({ media: 'photo', options: { format: 'image/tiff' } }, storage),
    (error) => error === denied
  )
  assert.equal(storage.values.get('export-settings'), original)
})

test('output sharpening is remembered only for rendered images and none preserves existing settings', () => {
  for (const format of ['image/jpeg', 'image/png', 'image/tiff', 'image/avif', 'image/jxl']) {
    const defaults = normalizeExportSettings({ format }, 'photo')
    assert.deepEqual(normalizeExportSettings({ format, outputSharpening: 'none' }, 'photo'), defaults)
    for (const outputSharpening of ['low', 'standard', 'high']) {
      const expected = { ...defaults, outputSharpening }
      assert.deepEqual(normalizeExportSettings({ format, outputSharpening }, 'photo'), expected)
      assert.deepEqual(normalizeExportSettings({ format, outputSharpening }, 'video'), expected)
    }
  }
  for (const format of [
    'original',
    'original-settings',
    'application/rdf+xml',
    'image/x-adobe-dng',
    'video/mp4',
    'video/webm'
  ]) {
    const media = format.startsWith('video/') ? 'video' : 'photo'
    assert.deepEqual(
      normalizeExportSettings({ format, outputSharpening: 'none' }, media),
      normalizeExportSettings({ format }, media)
    )
    assert.throws(() => normalizeExportSettings({ format, outputSharpening: 'standard' }, media))
  }
  const storage = storageFixture()
  saveExportSettings({ media: 'photo', options: { format: 'image/png', outputSharpening: 'high' } }, storage)
  saveExportSettings({ media: 'video', options: { format: 'image/tiff', outputSharpening: 'low' } }, storage)
  assert.equal(loadExportSettings(storage).photo.outputSharpening, 'high')
  assert.equal(loadExportSettings(storage).video.outputSharpening, 'low')
  const before = storage.values.get('export-settings')
  assert.throws(() =>
    saveExportSettings(
      { media: 'photo', options: { format: 'image/png', outputSharpening: 'maximum' } },
      storage
    )
  )
  assert.equal(storage.values.get('export-settings'), before)
})
