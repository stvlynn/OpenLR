import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runVideoTrials, videoTrialOutcome } from './native-video-trials.mjs'

export const audioLayoutOrder = Array.from({ length: 4 }, () => [
  'original-10000ns',
  'reticked-100000ns',
  'regrouped-100000ns',
  'regrouped-100000ns',
  'reticked-100000ns',
  'original-10000ns'
]).flat()

export function audioLayoutOutcome(code, signal, log) {
  // Share the host/oracle receipt gate; the strict audio smoke owns output assertions.
  const base = videoTrialOutcome(code, signal, log)
  const records = log.split(/\r?\n/).flatMap((line) => {
    try {
      return line.startsWith('{') ? [JSON.parse(line)] : []
    } catch {
      return []
    }
  })
  const evidence = records.find((record) => record.nativeAudioExport === 'passed')
  const beforeTrimChecks = records.filter(
    (record) => record.nativeAudioExport === 'original-before-trim-passed'
  ).length
  const exports = ['multitrack-webm-passed', 'multitrack-mp4-passed', 'aac-input-44100-passed'].map((kind) =>
    records.find((record) => record.nativeAudioExport === kind)
  )
  return {
    ...base,
    evidence,
    beforeTrimChecks,
    exports,
    cleanupReceipts: records.filter((record) => record.nativeVideoCleanup || record.nativeVideoOracleCleanup),
    verified:
      code === 0 &&
      signal === null &&
      base.cleanupConfirmed &&
      base.oracleCleanupConfirmed &&
      Boolean(evidence) &&
      beforeTrimChecks === 2 &&
      exports.every(Boolean)
  }
}

export async function runAudioLayoutComparison(executable, sourceDirectory, destination, ffmpegBin) {
  assert.ok(
    executable && sourceDirectory && destination,
    'Pass the stock OpenLR executable, prepared source directory and report directory'
  )
  const report = JSON.parse(await readFile(path.join(sourceDirectory, 'report.json'), 'utf8'))
  assert.equal(report.verified, true, 'Source preparation must verify packet and timing equivalence')
  const environments = {}
  for (const label of new Set(audioLayoutOrder)) {
    const source = path.resolve(sourceDirectory, label + '.webm')
    assert.ok((await readFile(source)).length > 0, 'Prepared source must not be empty')
    environments[label] = { OPENLR_AUDIO_SOURCE: source }
  }
  await runVideoTrials({
    apps: Object.fromEntries([...new Set(audioLayoutOrder)].map((label) => [label, executable])),
    order: audioLayoutOrder,
    destination,
    args: ffmpegBin ? [ffmpegBin] : [],
    environments,
    script: 'scripts/native-audio-export-smoke.mjs',
    outcome: audioLayoutOutcome,
    sharedFixture: false,
    metadata: {
      comparison: 'short-audio-source-layout',
      arms: 'Exact original; 100us scale-only with original clusters; 100us gap-preserving regroup',
      application: 'same stock executable for all three arms',
      sourcePreparation: report,
      originalReadBeforeTrim: true,
      timingScope:
        'The added original export/read occurs in all three arms before trim. It changes timing; a null result does not exclude the original failure.',
      assertions:
        'Unchanged trim, rotation, all-track WebM/MP4, 44.1kHz AAC, decoded PCM and original-byte checks'
    }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runAudioLayoutComparison(...process.argv.slice(2))
