import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'
import { makeVideoFixture } from './fixtures/video.mjs'

test('opt-in native seek tracing observes the real event before its awaited callback resolves', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.addInitScript(() => {
    window.seekRecords = []
    window.seekReplies = {}
    const pending = new Promise(() => {})
    window.mygo = {
      call(method, ...args) {
        if (method === 'Desktop.AgentPoll')
          return new Promise((resolve) => {
            window.deliverSeek = resolve
          })
        if (method === 'Desktop.AgentPollControl') return pending
        if (method === 'Desktop.AgentReply') {
          window.seekReplies[args[0]] = JSON.parse(args[1])
          return Promise.resolve()
        }
        if (method === 'Desktop.VideoImportDiagnostic') {
          window.seekRecords.push(JSON.parse(args[0]))
          return pending
        }
        if (method === 'Local.Folders') return Promise.resolve([])
        if (method === 'External.Editor') return Promise.resolve('')
        if (method === 'Sharing.State') return Promise.resolve({})
        return Promise.resolve()
      }
    }
  })
  await page.goto(server.url)
  const bytes = await makeVideoFixture(page)
  const imported = await page.evaluate((bytes) => {
    const file = new File([Uint8Array.from(bytes)], 'private-seek-fixture.webm', { type: 'video/webm' })
    return window.openlr.run('import', { files: [file] })
  }, Array.from(bytes))
  assert.deepEqual(imported.failed, [])
  const [photoId] = imported.added
  await page.evaluate((photoId) => {
    window.openlrDiagnostics = true
    const add = HTMLMediaElement.prototype.addEventListener
    HTMLMediaElement.prototype.addEventListener = function (type, listener, options) {
      if (this instanceof HTMLVideoElement && type === 'seeked' && options === undefined) {
        HTMLMediaElement.prototype.addEventListener = add
        return add.call(
          this,
          type,
          (event) => {
            window.seekEventTrusted = event.isTrusted
            window.resumeNativeSeek = () => listener.call(this, event)
          },
          { once: true }
        )
      }
      return add.call(this, type, listener, options)
    }
    window.deliverSeek({ id: 'private-seek-request', command: 'video-seek', args: { time: 2.35, photoId } })
  }, photoId)
  await page.waitForFunction(() => typeof window.resumeNativeSeek === 'function', null, { timeout: 5000 })
  const held = await page.evaluate(() => ({
    trusted: window.seekEventTrusted,
    records: window.seekRecords,
    reply: window.seekReplies['private-seek-request']
  }))
  assert.equal(held.trusted, true)
  assert.equal(held.reply, undefined)
  assert.deepEqual(
    held.records.map(({ stage }) => stage),
    [
      'renderer-received',
      'source-original',
      'source-original-read',
      'playback-load',
      'playback-loaded',
      'playback-opened',
      'seek-unchanged',
      'source-frame',
      'source-frame-read',
      'seek-start',
      'seek-assigned',
      'seek-event',
      'seek-event'
    ]
  )
  const assigned = held.records.find(({ stage }) => stage === 'seek-assigned')
  assert.equal(held.records.find(({ stage }) => stage === 'seek-unchanged').seekTime, 0)
  assert.equal(assigned.requestedTime, 2.35)
  assert.equal(assigned.seekTime, 2.35)
  assert.ok(Number.isFinite(assigned.currentTime))
  assert.ok(assigned.seekableRanges > 0)
  const completedEvent = held.records.at(-1)
  assert.equal(completedEvent.event, 'seeked')
  assert.equal(completedEvent.seeking, false)
  assert.ok(completedEvent.readyState >= 2)
  assert.ok(Math.abs(completedEvent.currentTime - 2.35) < 0.01)

  await page.evaluate(() => window.resumeNativeSeek())
  await page.waitForFunction(() => window.seekRecords.at(-1)?.stage === 'renderer-replied', null, {
    timeout: 5000
  })
  const { records, reply, pixel } = await page.evaluate(() => {
    const canvas = document.querySelector('#stage canvas')
    return {
      records: window.seekRecords,
      reply: window.seekReplies['private-seek-request'],
      pixel: Array.from(
        canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data
      )
    }
  })
  assert.equal(reply.ok, true, reply.error?.message)
  assert.equal(reply.result.selected, photoId)
  assert.equal(reply.result.playback.playing, false)
  assert.ok(Math.abs(reply.result.playback.time - 2.35) < 0.01)
  assert.ok(pixel[0] < 100 && pixel[1] < 100 && pixel[2] > 130 && pixel[3] === 255, JSON.stringify(pixel))
  assert.deepEqual(
    records.slice(held.records.length).map(({ stage }) => stage),
    [
      'seek-completed',
      'stage-frame',
      'stage-paint',
      'stage-painted',
      'renderer-dispatched',
      'renderer-replied'
    ]
  )
  assert.equal(new Set(records.map(({ sequence }) => sequence)).size, 1)
  assert.ok(records.every(({ operation, elapsedMs }) => operation === 'seek' && Number.isFinite(elapsedMs)))
  assert.doesNotMatch(JSON.stringify(records), /private-seek|blob:|https?:/)
  assert.ok(!JSON.stringify(records).includes(photoId))
})

test('origin-restricted video uses decoded frames through live playback, seeking and saved stills', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const bytes = await makeVideoFixture(page)
  const imported = await page.evaluate(async (bytes) => {
    const tainted = new WeakSet(),
      drawImage = CanvasRenderingContext2D.prototype.drawImage,
      getImageData = CanvasRenderingContext2D.prototype.getImageData,
      createImageBitmap = globalThis.createImageBitmap,
      toBlob = HTMLCanvasElement.prototype.toBlob,
      toDataURL = HTMLCanvasElement.prototype.toDataURL
    const restricted = (source) => source instanceof HTMLVideoElement || tainted.has(source)
    const securityError = () => new DOMException('Unreadable video pixels', 'SecurityError')
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      const result = drawImage.call(this, source, ...args)
      if (restricted(source)) tainted.add(this.canvas)
      return result
    }
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      if (tainted.has(this.canvas)) throw securityError()
      return getImageData.apply(this, args)
    }
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      if (tainted.has(this)) throw securityError()
      return toBlob.apply(this, args)
    }
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      if (tainted.has(this)) throw securityError()
      return toDataURL.apply(this, args)
    }
    globalThis.createImageBitmap = async (source, ...args) => {
      const bitmap = await createImageBitmap(source, ...args)
      if (restricted(source)) tainted.add(bitmap)
      return bitmap
    }
    const file = new File([Uint8Array.from(bytes)], 'restricted.webm', { type: 'video/webm' })
    return window.openlr.run('import', { files: [file] })
  }, Array.from(bytes))
  assert.deepEqual(imported.failed, [])
  assert.equal(imported.added.length, 1)

  const seek = (time) => page.evaluate((time) => window.openlr.run('video-seek', { time }), time)
  const stageColor = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('#stage canvas')
      return Array.from(
        canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data
      )
    })
  const expectColor = (pixel, channel) => {
    assert.equal(pixel[3], 255)
    assert.ok(
      pixel[channel] > 130 && pixel.every((value, index) => index === channel || index === 3 || value < 100),
      JSON.stringify(pixel)
    )
  }
  await seek(0.35)
  expectColor(await stageColor(), 0)
  await page.locator('#play-video').click()
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#stage canvas')
    if (!canvas) return false
    const [red, green, blue] = canvas
      .getContext('2d')
      .getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data
    return green > 130 && red < 100 && blue < 100
  })
  const paused = await page.evaluate(() => window.openlr.run('video-pause'))
  assert.equal(paused.playback.playing, false)
  assert.ok(paused.playback.time > 1)
  await seek(2.35)
  expectColor(await stageColor(), 2)

  const result = await page.evaluate(async () => {
    const run = window.openlr.run,
      original = await run('export', { format: 'original' }),
      still = await run('save-frame'),
      exported = await run('export', { format: 'original' }),
      bitmap = await createImageBitmap(exported.blob),
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
      context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    return {
      still,
      filename: exported.filename,
      size: [canvas.width, canvas.height],
      pixel: Array.from(context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data),
      original: Array.from(new Uint8Array(await original.blob.arrayBuffer()))
    }
  })
  assert.deepEqual(result.still.failed, [])
  assert.equal(result.still.added.length, 1)
  assert.equal(result.filename, 'restricted-2350.png')
  assert.deepEqual(result.size, [96, 64])
  assert.deepEqual(Buffer.from(result.original), bytes)
  expectColor(result.pixel, 2)
})

test('video trim, grading, playback and export preserve the audio track and selected frames', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const m = await import('./vendor/mediabunny/mediabunny.mjs')
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 64
    const ctx = canvas.getContext('2d'),
      target = new m.BufferTarget()
    const out = new m.Output({ target, format: new m.WebMOutputFormat() })
    const video = new m.CanvasSource(canvas, { codec: 'vp9', bitrate: 300000 }),
      audio = new m.AudioBufferSource({ codec: 'opus', bitrate: 64000 })
    out.addVideoTrack(video)
    out.addAudioTrack(audio)
    await out.start()
    const tone = new AudioBuffer({ numberOfChannels: 1, length: 48000, sampleRate: 48000 })
    tone
      .getChannelData(0)
      .forEach((_, i, data) => (data[i] = 0.2 * Math.sin((i / 48000) * 440 * 2 * Math.PI)))
    const audioDone = audio.add(tone)
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = i < 5 ? '#777777' : '#173bd0'
      ctx.fillRect(0, 0, 96, 64)
      await video.add(i / 10, 0.1)
    }
    await audioDone
    await out.finalize()
    const file = new File([target.buffer], 'color-bars.webm', { type: 'video/webm' })
    const run = window.openlr.run
    const imported = await run('import', { files: [file] })
    if (imported.failed.length) throw Error(imported.failed[0].error)
    await run('video-seek', { time: 0.55 })
    await run('video-trim', { start: 0.4, end: 0.8 })
    await run('edit', { key: 'Exposure', value: 0.5 })
    await run('edit', { key: 'turn', value: 1 })
    const playback = (await run('state')).playback
    const { blob } = await run('export', { format: 'video/webm' })
    const input = new m.Input({ source: new m.BlobSource(blob), formats: m.ALL_FORMATS })
    try {
      const track = await input.getPrimaryVideoTrack(),
        a = await input.getPrimaryAudioTrack()
      const sample = await new m.CanvasSink(track).getCanvas(0.2)
      const color = Array.from(sample.canvas.getContext('2d').getImageData(1, 1, 1, 1).data)
      return {
        size: [await track.getDisplayWidth(), await track.getDisplayHeight()],
        type: blob.type,
        duration: await input.computeDuration(),
        audio: await a.getCodec(),
        color,
        playback
      }
    } finally {
      input.dispose()
    }
  })
  assert.deepEqual(result.size, [64, 96])
  assert.equal(result.audio, 'opus')
  assert.equal(result.type, 'video/webm')
  assert.ok(Math.abs(result.duration - 0.4) < 0.055, JSON.stringify(result))
  assert.ok(result.color[2] > result.color[0] * 2 && result.color[2] > 210, JSON.stringify(result))
  assert.ok(Math.abs(result.playback.time - 0.4) < 0.025)
})

test('opt-in video import diagnostics report pending media and preserve success or the original failure', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const m = await import('./vendor/mediabunny/mediabunny.mjs')
    const canvas = document.createElement('canvas')
    canvas.width = 48
    canvas.height = 32
    const context = canvas.getContext('2d'),
      target = new m.BufferTarget(),
      output = new m.Output({ target, format: new m.WebMOutputFormat() }),
      video = new m.CanvasSource(canvas, { codec: 'vp9', bitrate: 100000 })
    output.addVideoTrack(video)
    await output.start()
    for (let i = 0; i < 3; i++) {
      context.fillStyle = i ? '#3259c0' : '#c0322a'
      context.fillRect(0, 0, canvas.width, canvas.height)
      await video.add(i / 5, 0.2)
    }
    await output.finalize()
    const file = new File([target.buffer], 'private-clip.webm', { type: 'video/webm' }),
      diagnosticCalls = [],
      bitmap = globalThis.createImageBitmap,
      toDataURL = HTMLCanvasElement.prototype.toDataURL
    let diagnosticBehavior, onLoadedData
    globalThis.mygo = {
      call(method, value) {
        if (method !== 'Desktop.VideoImportDiagnostic') return Promise.resolve()
        const record = JSON.parse(value)
        diagnosticCalls.push(record)
        if (record.event === 'loadeddata') onLoadedData?.(record.sequence)
        if (diagnosticBehavior === 'throw') throw Error('Diagnostic call threw')
        if (diagnosticBehavior === 'reject') return Promise.reject(Error('Diagnostic call rejected'))
        if (diagnosticBehavior === 'pending') return new Promise(() => {})
        return Promise.resolve()
      }
    }
    const imported = () => window.openlr.run('import', { files: [file] })
    try {
      globalThis.createImageBitmap = (source, ...options) => {
        if (source instanceof HTMLVideoElement)
          return Promise.reject(new DOMException('Private bitmap failure', 'SecurityError'))
        return bitmap(source, ...options)
      }
      const optedOut = await imported(),
        optedOutCalls = diagnosticCalls.length
      globalThis.openlrDiagnostics = true
      const bitmapFailure = await imported()
      globalThis.createImageBitmap = bitmap
      HTMLCanvasElement.prototype.toDataURL = function () {
        throw new DOMException('Private thumbnail failure', 'SecurityError')
      }
      const thumbnailFailure = await imported()
      const reportFailures = []
      for (diagnosticBehavior of ['throw', 'reject', 'pending']) {
        let timeout
        try {
          reportFailures.push(
            await Promise.race([
              imported(),
              new Promise((resolve) => (timeout = setTimeout(() => resolve('Import did not return'), 2000)))
            ])
          )
        } finally {
          clearTimeout(timeout)
        }
      }
      const photos = (await window.openlr.run('state')).photos
      HTMLCanvasElement.prototype.toDataURL = toDataURL
      const addEventListener = HTMLMediaElement.prototype.addEventListener
      let release,
        settled = false,
        deadline
      // Hold the application's awaited callback while the real loadeddata event
      // still reaches the independent diagnostic listener.
      HTMLMediaElement.prototype.addEventListener = function (event, listener, options) {
        if (event === 'loadeddata' && options === undefined) {
          release = () => listener.call(this)
          return
        }
        return addEventListener.call(this, event, listener, options)
      }
      let suspended, successful
      try {
        const observed = new Promise((resolve) => (onLoadedData = resolve))
        const loading = imported().then((value) => {
          settled = true
          return value
        })
        const timeout = new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(Error('Expected actual Chrome loadeddata and completed import')),
            3000
          )
        })
        const sequence = await Promise.race([observed, timeout])
        suspended = {
          settled,
          records: diagnosticCalls.filter((record) => record.sequence === sequence)
        }
        release()
        successful = await Promise.race([loading, timeout])
      } finally {
        clearTimeout(deadline)
        onLoadedData = undefined
        delete HTMLMediaElement.prototype.addEventListener
      }
      const offset = diagnosticCalls.length
      const { beginNativeVideoImportTrace, markNativeVideoImport } =
        await import('./video-import-diagnostics.js')
      for (const [command, files] of [
        ['import', []],
        ['import', [{ type: 'image/png' }, null, { type: 42 }]],
        ['state', [{ type: 'video/webm' }]],
        ['import', [{ type: 'video/webm', name: 'private-clip.webm', base64: 'private-bytes' }]]
      ]) {
        const started = beginNativeVideoImportTrace({ command, args: { files } })
        markNativeVideoImport(started, 'renderer-dispatched')
        markNativeVideoImport(started, 'renderer-replied')
      }
      return {
        optedOut,
        optedOutCalls,
        bitmapFailure,
        thumbnailFailure,
        reportFailures,
        diagnosticCalls: diagnosticCalls.slice(0, offset),
        bridgeRecords: diagnosticCalls.slice(offset),
        photos,
        suspended,
        successful
      }
    } finally {
      delete globalThis.openlrDiagnostics
      delete globalThis.mygo
      globalThis.createImageBitmap = bitmap
      HTMLCanvasElement.prototype.toDataURL = toDataURL
    }
  })
  assert.equal(result.optedOutCalls, 0)
  assert.deepEqual(result.optedOut, result.bitmapFailure)
  assert.deepEqual(result.bitmapFailure.failed, [
    { name: 'private-clip.webm', error: 'Private bitmap failure' }
  ])
  assert.deepEqual(result.thumbnailFailure.failed, [
    { name: 'private-clip.webm', error: 'Private thumbnail failure' }
  ])
  assert.deepEqual(result.reportFailures, Array(3).fill(result.thumbnailFailure))
  assert.deepEqual(result.photos, [])
  assert.deepEqual(result.successful.failed, [])
  assert.equal(result.successful.added.length, 1)
  assert.equal(result.suspended.settled, false)
  const pendingPhases = result.suspended.records.filter(({ event }) => !event).map(({ stage }) => stage)
  assert.deepEqual(pendingPhases, ['input', 'media-load'])
  assert.ok(
    result.suspended.records.some(({ event, readyState }) => event === 'loadeddata' && readyState >= 2)
  )
  assert.deepEqual(
    result.bridgeRecords.map(({ stage }) => stage),
    ['renderer-received', 'renderer-dispatched', 'renderer-replied']
  )
  assert.ok(result.bridgeRecords.every((record) => Object.keys(record).sort().join() === 'elapsedMs,stage'))
  const failures = result.diagnosticCalls.filter(({ errorName }) => errorName)
  assert.deepEqual(
    failures.map(({ stage }) => stage),
    ['poster-bitmap', ...Array(4).fill('thumbnail-encode')]
  )
  for (const diagnostic of failures) {
    assert.equal(diagnostic.errorName, 'SecurityError')
    assert.equal(diagnostic.declaredVideoType, true)
    assert.equal(diagnostic.secureContext, true)
    assert.equal(diagnostic.nativeScheme, false)
    assert.equal(diagnostic.blobOrigin, 'same')
    assert.ok(diagnostic.readyState >= 2)
    assert.deepEqual([diagnostic.width, diagnostic.height, diagnostic.mediaErrorCode], [48, 32, null])
    assert.equal(typeof diagnostic.videoDecoder, 'boolean')
    assert.equal(typeof diagnostic.audioEncoder, 'boolean')
  }
  const groups = Map.groupBy(result.diagnosticCalls, ({ sequence }) => sequence)
  assert.equal(groups.size, 6)
  for (const records of groups.values()) {
    const phases = records.filter(({ event, errorName }) => !event && !errorName).map(({ stage }) => stage)
    const events = records.flatMap(({ event }) => (event ? [event] : []))
    assert.equal(new Set(phases).size, phases.length)
    assert.equal(new Set(events).size, events.length)
    assert.ok(
      events.every((event) =>
        ['loadstart', 'loadedmetadata', 'loadeddata', 'stalled', 'suspend', 'error'].includes(event)
      )
    )
    assert.ok(records.every(({ elapsedMs }) => Number.isSafeInteger(elapsedMs) && elapsedMs >= 0))
    assert.ok(records.length <= 19)
  }
  const last = [...groups.values()]
    .at(-1)
    .filter(({ event }) => !event)
    .map(({ stage }) => stage)
  assert.deepEqual(last, [
    'input',
    'media-load',
    'media-duration',
    'frame-access',
    'frame-read',
    'poster-bitmap',
    'photo-record',
    'thumbnail-render',
    'thumbnail-encode',
    'catalog-write',
    'catalog-written'
  ])
  assert.doesNotMatch(
    JSON.stringify([result.diagnosticCalls, result.bridgeRecords]),
    /private|https?:|blob:/i
  )
})
