import assert from 'node:assert/strict'
import { videoFailureDetails } from '../web/video-errors.js'
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startCohortResourceObserver } from './native-cohort-resources.mjs'

export function videoTrialOutcome(code, signal, log) {
  const records = log
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const cleanupConfirmed = records.some((record) => record.nativeVideoCleanup === 'confirmed')
  const oracleCleanupConfirmed = records.some((record) => record.nativeVideoOracleCleanup === 'confirmed')
  const evidence = records.find((record) => record.nativeVideo === 'passed')
  const failure = videoFailureDetails(records.find((record) => record.nativeVideo === 'failed')?.failure)
  const browser = records.find((record) => record.nativeVideoBrowser)?.nativeVideoBrowser
  return {
    code,
    signal,
    cleanupConfirmed,
    oracleCleanupConfirmed,
    verified:
      code === 0 && signal === null && cleanupConfirmed && oracleCleanupConfirmed && Boolean(evidence),
    evidence,
    ...(failure && { failure }),
    browser,
    continueTrials: cleanupConfirmed && oracleCleanupConfirmed && signal === null
  }
}

export async function runVideoTrials({ apps, order, destination, args = [], environments = {} }) {
  await mkdir(destination, { recursive: true })
  const fixture = path.resolve(destination, 'fixture.webm')
  const trials = []
  const observer =
    process.env.OPENLR_COHORT_RESOURCES === '1'
      ? await startCohortResourceObserver({ filePath: path.join(destination, 'cohort-resources.jsonl') })
      : null
  let primaryFailure
  try {
    for (const [index, candidate] of order.entries()) {
      const beforeStarted = performance.now()
      const before = await observer?.sample({ phase: 'before-trial', index, candidate })
      const beforeMs = performance.now() - beforeStarted
      const logPath = path.join(destination, `${index}-${candidate}.log`)
      const output = await open(logPath, 'wx')
      const started = performance.now()
      let code, signal
      try {
        const child = spawn(
          process.execPath,
          ['scripts/native-video-smoke.mjs', path.resolve(apps[candidate]), ...args],
          {
            env: {
              ...process.env,
              OPENLR_DIAGNOSTICS: '1',
              ...environments[candidate],
              OPENLR_VIDEO_PROBE_FIXTURE: fixture
            },
            stdio: ['ignore', output.fd, output.fd],
            windowsHide: true
          }
        )
        ;[code, signal] = await new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve([code, signal]))
        })
      } finally {
        await output.close()
      }
      const outcome = videoTrialOutcome(code, signal, await readFile(logPath, 'utf8'))
      const elapsedMs = performance.now() - started
      const afterStarted = performance.now()
      let observationFailure
      const after = await observer
        ?.sample({
          phase: 'after-trial',
          index,
          candidate,
          trialElapsedMs: elapsedMs,
          code,
          signal,
          cleanupConfirmed: outcome.cleanupConfirmed,
          oracleCleanupConfirmed: outcome.oracleCleanupConfirmed
        })
        .catch((error) => {
          observationFailure = error
          return { elapsedMs: 0 }
        })
      const afterMs = performance.now() - afterStarted
      const trial = {
        index,
        candidate,
        elapsedMs,
        ...outcome,
        ...(observationFailure && {
          observationError: { name: observationFailure.name, code: observationFailure.code ?? null }
        }),
        ...(observer && {
          observationMs: { before: beforeMs, after: afterMs },
          observationStatus: { before: before.status, after: after.status ?? 'failed' }
        })
      }
      trials.push(trial)
      console.log(JSON.stringify(trial))
      await writeFile(
        path.join(destination, 'report.json'),
        JSON.stringify(
          {
            platform: process.platform,
            arch: process.arch,
            order,
            complete: trials.length === order.length,
            trials
          },
          null,
          2
        )
      )
      if (!outcome.continueTrials)
        throw Error('Video trial cleanup was not confirmed; no further host will start')
      if (observationFailure)
        throw new Error('Resource observation failed after the retained trial; no further host will start', {
          cause: observationFailure
        })
    }
    assert.ok(
      trials.every((trial) => trial.verified),
      'Video trial schedule retained failed trials'
    )
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    try {
      await observer?.close()
    } catch (error) {
      if (!primaryFailure) throw error
      console.error('Resource observer close failed:', error.code ?? error.name)
    }
  }
}
