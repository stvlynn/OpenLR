import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { audioLayoutOrder, audioLayoutOutcome } from '../scripts/native-audio-layout-comparison.mjs'
import { runVideoTrials } from '../scripts/native-video-trials.mjs'

const receipts = [{ nativeVideoCleanup: 'confirmed' }, { nativeVideoOracleCleanup: 'confirmed' }]
const evidence = [
  ...Array.from({ length: 2 }, () => ({ nativeAudioExport: 'original-before-trim-passed' })),
  ...['multitrack-webm-passed', 'multitrack-mp4-passed', 'aac-input-44100-passed', 'passed'].map(
    (nativeAudioExport) => ({ nativeAudioExport })
  )
]
const lines = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n'

test('audio layout schedule and result keep semantic success separate from confirmed cleanup', () => {
  assert.equal(audioLayoutOrder.length, 24)
  assert.deepEqual(audioLayoutOrder.slice(0, 6), [
    'original-10000ns',
    'reticked-100000ns',
    'regrouped-100000ns',
    'regrouped-100000ns',
    'reticked-100000ns',
    'original-10000ns'
  ])
  assert.equal(new Set(audioLayoutOrder).size, 3)
  for (let block = 1; block < 4; block++)
    assert.deepEqual(audioLayoutOrder.slice(block * 6, block * 6 + 6), audioLayoutOrder.slice(0, 6))
  for (const label of new Set(audioLayoutOrder))
    assert.equal(audioLayoutOrder.filter((item) => item === label).length, 8)
  const log = lines([...evidence, ...receipts])
  assert.equal(audioLayoutOutcome(0, null, log).verified, true)
  assert.equal(audioLayoutOutcome(1, null, log).verified, false)
  assert.equal(audioLayoutOutcome(1, null, lines(receipts)).continueTrials, true)
  assert.equal(audioLayoutOutcome(0, null, lines(receipts)).verified, false)
  assert.equal(audioLayoutOutcome(0, null, lines([...evidence, receipts[0]])).continueTrials, false)
  assert.equal(audioLayoutOutcome(null, 'SIGTERM', log).continueTrials, false)
  assert.equal(audioLayoutOutcome(0, null, lines([...evidence.slice(1), ...receipts])).verified, false)
  assert.deepEqual(audioLayoutOutcome(0, null, log).cleanupReceipts, receipts)
})

test('shared scheduler observes real child close, retains failed trials and stops on missing cleanup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openlr-audio-schedule-'))
  assert.equal(path.dirname(root), path.resolve(tmpdir()))
  try {
    const script = path.join(root, 'controlled-child.mjs')
    await writeFile(
      script,
      `
      const records = JSON.parse(process.env.CONTROLLED_RECORDS)
      console.error('original controlled error retained')
      for (const record of records) console.log(JSON.stringify(record))
      process.exitCode = Number(process.env.CONTROLLED_CODE || 0)
    `
    )
    const options = {
      apps: { control: process.execPath, candidate: process.execPath },
      order: ['control', 'candidate'],
      script,
      outcome: audioLayoutOutcome,
      sharedFixture: false,
      environments: {
        control: { CONTROLLED_RECORDS: JSON.stringify(receipts), CONTROLLED_CODE: '1' },
        candidate: { CONTROLLED_RECORDS: JSON.stringify([...evidence, ...receipts]) }
      }
    }
    const completed = path.join(root, 'completed')
    await assert.rejects(runVideoTrials({ ...options, destination: completed }), /retained failed trials/)
    const report = JSON.parse(await readFile(path.join(completed, 'report.json')))
    assert.equal(report.complete, true)
    assert.deepEqual(
      report.trials.map(({ verified }) => verified),
      [false, true]
    )
    assert.match(await readFile(path.join(completed, '0-control.log'), 'utf8'), /original controlled error/)
    const stopped = path.join(root, 'stopped')
    await assert.rejects(
      runVideoTrials({
        ...options,
        destination: stopped,
        environments: { ...options.environments, control: { CONTROLLED_RECORDS: JSON.stringify(evidence) } }
      }),
      /cleanup was not confirmed/
    )
    const partial = JSON.parse(await readFile(path.join(stopped, 'report.json')))
    assert.equal(partial.complete, false)
    assert.equal(partial.trials.length, 1)
    await assert.rejects(readFile(path.join(stopped, '1-candidate.log')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
