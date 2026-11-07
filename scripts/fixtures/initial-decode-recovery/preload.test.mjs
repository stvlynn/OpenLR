import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { serveWorkspace } from '../../../tests/browser-server.mjs'
import { initialDecodeOutcome, instrumentMain, revisions } from '../../native-initial-decode-comparison.mjs'

const preload = await readFile(new URL('./preload.js', import.meta.url), 'utf8')
const show = (revision, file) => execFileSync('git', ['show', revision + ':' + file])

test('the diagnostic preload targets the second real metadata event and the actual candidate recovers', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const bytes = [...show(revisions.harness, 'scripts/fixtures/short-audio-layout/failed-multitrack.webm')]
  assert.equal(bytes.length, 59365)
  for (const label of ['baseline', 'candidate']) {
    await t.test(label, async () => {
      const page = await browser.newPage()
      try {
        await page.route('**/video.js', (route) =>
          route.fulfill({ contentType: 'text/javascript', body: show(revisions[label], 'web/video.js') })
        )
        await page.addInitScript({ content: "globalThis.openlrNativePlatform = 'darwin'\n" + preload })
        await page.goto(server.url)
        const result = await page.evaluate(async (bytes) => {
          const records = []
          globalThis.mygo = {
            call: (method, report) => {
              if (method === 'Desktop.VideoImportDiagnostic') records.push(JSON.parse(report))
              return Promise.resolve()
            }
          }
          const run = window.openlr.run
          const imported = await run('import', {
            files: [new File([Uint8Array.from(bytes)], 'multitrack.webm', { type: 'video/webm' })]
          })
          if (imported.failed.length) throw Error(imported.failed[0].error)
          const trim = await run('video-trim', { start: 0.5, end: 0.7 }).catch(({ message }) => message)
          const state = await run('state')
          let pixel
          if (state.mode === 'detail') {
            const canvas = document.querySelector('#stage canvas')
            pixel = [
              ...canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data
            ]
          }
          const original = [
            ...new Uint8Array(await (await run('export', { format: 'original' })).blob.arrayBuffer())
          ]
          await run('library')
          return {
            records: records.filter(({ operation }) => operation === 'controlled-initial-decode'),
            trim,
            state,
            pixel,
            original
          }
        }, bytes)
        const injected = result.records.filter(({ stage }) => stage === 'injected')
        assert.equal(injected.length, 1)
        assert.deepEqual(injected[0], {
          operation: 'controlled-initial-decode',
          stage: 'injected',
          trusted: true,
          width: 96,
          height: 64,
          readyState: injected[0].readyState,
          mediaErrorCode: 3,
          assignment: 2
        })
        assert.ok(injected[0].readyState >= 1)
        const release = result.records.find(({ stage }) => stage === 'failed-player-released')
        assert.equal(release.sourceRemoved, true)
        assert.equal(release.readyState, 0)
        assert.deepEqual(result.original, bytes)
        const assigned = result.records.filter(({ stage }) => stage === 'source-assigned')
        if (label === 'baseline') {
          assert.equal(result.trim, 'Controlled initial native decode failure')
          assert.equal(result.state.mode, 'grid')
          assert.equal(assigned.length, 2)
        } else {
          assert.equal(result.state.mode, 'detail')
          assert.deepEqual(result.state.photos[0].edit.trim, { start: 0.5, end: 0.7 })
          assert.equal(assigned.length, 3)
          assert.equal(assigned[2].sameOriginal, true)
          const loaded = result.records.filter(({ stage }) => stage === 'recovery-loadeddata')
          assert.equal(loaded.length, 1)
          assert.equal(loaded[0].trusted, true)
          assert.ok(loaded[0].readyState >= 2)
          assert.ok(
            result.pixel[0] > 100 &&
              result.pixel[1] < 100 &&
              result.pixel[2] < 100 &&
              result.pixel[3] === 255,
            JSON.stringify(result.pixel)
          )
        }
        assert.equal(JSON.stringify(result.records).includes('multitrack.webm'), false)
      } finally {
        await page.close()
      }
    })
  }
})

test('controlled native acceptance retains the baseline failure and requires concrete recovery evidence', () => {
  const diagnostic = (record) => 'OpenLR video import diagnostic: ' + JSON.stringify(record)
  const controlled = (stage, detail) =>
    diagnostic({ operation: 'controlled-initial-decode', stage, ...detail })
  const source = JSON.stringify({
    nativeAudioExport: 'source-ready',
    bytes: 59365,
    retained: true,
    originalReadBeforeTrim: false
  })
  const admission = controlled('injected', {
    trusted: true,
    width: 96,
    height: 64,
    readyState: 1,
    mediaErrorCode: 3,
    assignment: 2
  })
  const released = controlled('failed-player-released', { sourceRemoved: true, readyState: 0 })
  const assigned = [1, 2].map((assignment) => controlled('source-assigned', { assignment }))
  const baselineLog = [
    source,
    ...assigned,
    admission,
    released,
    'Controlled initial native decode failure'
  ].join('\n')
  const base = {
    cleanupConfirmed: true,
    oracleCleanupConfirmed: true,
    continueTrials: true,
    beforeTrimChecks: 0,
    evidence: undefined,
    exports: [undefined, undefined, undefined],
    verified: false
  }
  assert.equal(initialDecodeOutcome(base, 1, null, baselineLog, 'baseline').verified, true)
  assert.equal(initialDecodeOutcome(base, 0, null, baselineLog, 'baseline').verified, false)
  assert.equal(
    initialDecodeOutcome(base, 1, null, baselineLog.replace(admission, ''), 'baseline').verified,
    false
  )
  assert.equal(
    initialDecodeOutcome({ ...base, oracleCleanupConfirmed: false }, 1, null, baselineLog, 'baseline')
      .continueTrials,
    false
  )
  assert.equal(
    initialDecodeOutcome(base, 1, null, baselineLog + '\nNative workspace cleanup failed', 'baseline')
      .continueTrials,
    false
  )
  const retry = diagnostic({ operation: 'trim', stage: 'playback-load-retry' })
  const candidateLog = [
    source,
    ...assigned,
    admission,
    released,
    retry,
    controlled('source-assigned', { assignment: 3, sameOriginal: true }),
    controlled('recovery-loadeddata', { trusted: true, width: 96, height: 64, readyState: 2 }),
    JSON.stringify({ controlledInitialDecodeImage: 'passed' })
  ].join('\n')
  const passed = {
    ...base,
    evidence: { originalBytes: 59365 },
    exports: Array(3).fill({ originalBytes: 59365 }),
    verified: true
  }
  assert.equal(initialDecodeOutcome(passed, 0, null, candidateLog, 'candidate').verified, true)
  assert.equal(initialDecodeOutcome(passed, 1, null, candidateLog, 'candidate').verified, false)
  assert.equal(
    initialDecodeOutcome(
      passed,
      0,
      null,
      candidateLog.replace('{"controlledInitialDecodeImage":"passed"}', ''),
      'candidate'
    ).verified,
    false
  )
  assert.equal(
    initialDecodeOutcome(passed, 0, null, candidateLog.replace(retry, ''), 'candidate').verified,
    false
  )
  assert.equal(
    initialDecodeOutcome(passed, 0, null, candidateLog + '\n' + retry, 'candidate').verified,
    false
  )
  assert.equal(
    initialDecodeOutcome(
      passed,
      0,
      null,
      candidateLog.replace('"trusted":true', '"trusted":false'),
      'candidate'
    ).verified,
    false
  )
  assert.equal(
    initialDecodeOutcome({ ...passed, verified: false }, 1, null, candidateLog, 'candidate').verified,
    false
  )
})

test('temporary main instrumentation appends one preload without modifying native setup', () => {
  const original = show(revisions.common, 'main.go').toString()
  const instrumented = instrumentMain(original, preload)
  assert.equal(
    instrumented.replace('\t\tpage.PreloadScript += ' + JSON.stringify(preload) + '\n', ''),
    original
  )
  assert.throws(() => instrumentMain('changed source without anchor', preload), /exactly once/)
})
