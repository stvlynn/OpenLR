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

export const audioReadTimingOrder = Array.from({ length: 6 }, () => [
  'original-workflow',
  'added-read',
  'added-read',
  'original-workflow'
]).flat()

export function audioComparisonPlan(comparison = 'layout') {
  assert.ok(['layout', 'read-timing'].includes(comparison), 'Choose layout or read-timing comparison')
  const order = comparison === 'layout' ? audioLayoutOrder : audioReadTimingOrder
  const arms = Object.fromEntries(
    [...new Set(order)].map((label) => [
      label,
      {
        filename: comparison === 'layout' ? label + '.webm' : 'original-10000ns.webm',
        originalReadBeforeTrim: label !== 'original-workflow'
      }
    ])
  )
  return { order, arms }
}

export function audioLayoutOutcome(code, signal, log, expectedBeforeTrimChecks = 2) {
  assert.ok([0, 2].includes(expectedBeforeTrimChecks), 'Expected zero or two diagnostic pre-trim reads')
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
    expectedBeforeTrimChecks,
    exports,
    cleanupReceipts: records.filter((record) => record.nativeVideoCleanup || record.nativeVideoOracleCleanup),
    verified:
      code === 0 &&
      signal === null &&
      base.cleanupConfirmed &&
      base.oracleCleanupConfirmed &&
      Boolean(evidence) &&
      beforeTrimChecks === expectedBeforeTrimChecks &&
      exports.every(Boolean)
  }
}

export async function runAudioLayoutComparison(
  executable,
  sourceDirectory,
  destination,
  ffmpegBin,
  comparison = 'layout'
) {
  assert.ok(
    executable && sourceDirectory && destination,
    'Pass the stock OpenLR executable, prepared source directory and report directory'
  )
  const report = JSON.parse(await readFile(path.join(sourceDirectory, 'report.json'), 'utf8'))
  assert.equal(report.verified, true, 'Source preparation must verify packet and timing equivalence')
  const { order, arms } = audioComparisonPlan(comparison)
  const environments = {}
  for (const [label, arm] of Object.entries(arms)) {
    const source = path.resolve(sourceDirectory, arm.filename)
    assert.ok((await readFile(source)).length > 0, 'Prepared source must not be empty')
    environments[label] = {
      OPENLR_AUDIO_SOURCE: source,
      OPENLR_AUDIO_ORIGINAL_BEFORE_TRIM: arm.originalReadBeforeTrim ? '1' : '0'
    }
  }
  await runVideoTrials({
    apps: Object.fromEntries(Object.keys(arms).map((label) => [label, executable])),
    order,
    destination,
    args: ffmpegBin ? [ffmpegBin] : [],
    environments,
    script: 'scripts/native-audio-export-smoke.mjs',
    outcome: (code, signal, log, label) =>
      audioLayoutOutcome(code, signal, log, arms[label].originalReadBeforeTrim ? 2 : 0),
    sharedFixture: false,
    metadata: {
      comparison: 'short-audio-' + comparison,
      arms,
      application: 'same stock executable for every arm',
      sourcePreparation: report,
      timingScope:
        comparison === 'layout'
          ? 'The added original export/read occurs in all three arms before trim. It changes timing; a null result does not exclude the original failure.'
          : 'Both arms use the exact retained original. The original-workflow arm omits only the added pre-trim export/read; added-read performs it for both WebM and AAC. Post-trim original and all output assertions remain identical. A finite null result cannot establish elimination of an intermittent failure.',
      assertions:
        'Unchanged trim, rotation, all-track WebM/MP4, 44.1kHz AAC, decoded PCM and original-byte checks'
    }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const modes = args.filter((arg) => arg.startsWith('--comparison='))
  assert.ok(modes.length <= 1, 'Pass at most one --comparison=layout|read-timing option')
  const positional = args.filter((arg) => !arg.startsWith('--comparison='))
  assert.ok(
    positional.length >= 3 && positional.length <= 4,
    'Pass executable, source directory, report directory, optional FFmpeg directory and --comparison=layout|read-timing'
  )
  await runAudioLayoutComparison(
    ...positional.slice(0, 3),
    positional[3],
    modes[0]?.slice('--comparison='.length) ?? 'layout'
  )
}
