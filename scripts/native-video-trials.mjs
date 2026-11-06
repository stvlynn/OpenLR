import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

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
  const evidence = records.find((record) => record.nativeVideo === 'passed')
  const browser = records.find((record) => record.nativeVideoBrowser)?.nativeVideoBrowser
  return {
    code,
    signal,
    cleanupConfirmed,
    verified: code === 0 && signal === null && cleanupConfirmed && Boolean(evidence),
    evidence,
    browser,
    continueTrials: cleanupConfirmed && signal === null
  }
}

export async function runVideoTrials({ apps, order, destination, args = [] }) {
  await mkdir(destination, { recursive: true })
  const trials = []
  for (const [index, candidate] of order.entries()) {
    const logPath = path.join(destination, `${index}-${candidate}.log`)
    const output = await open(logPath, 'wx')
    const started = performance.now()
    let code, signal
    try {
      const child = spawn(
        process.execPath,
        ['scripts/native-video-smoke.mjs', path.resolve(apps[candidate]), ...args],
        {
          env: { ...process.env, OPENLR_DIAGNOSTICS: '1' },
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
    const trial = { index, candidate, elapsedMs: performance.now() - started, ...outcome }
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
  }
  assert.ok(
    trials.every((trial) => trial.verified),
    'Video trial schedule retained failed trials'
  )
}
