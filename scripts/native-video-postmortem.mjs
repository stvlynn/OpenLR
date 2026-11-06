import { execFile } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { findMacCrashReport } from './native-startup-diagnostics.mjs'

const [directory] = process.argv.slice(2)
if (!directory) throw Error('Pass the ordinary video trial directory')
const run = promisify(execFile)
const { trials } = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'))
const prefix = 'Native workflow failure diagnostics: '
const date = (value) => new Date(value).toISOString().slice(0, 19).replace('T', ' ')
const safeName = (value) =>
  typeof value === 'string' && /^[a-z0-9_. -]{1,100}$/i.test(value) ? value : undefined

async function unifiedLog(pid, start, end) {
  try {
    const { stdout } = await run(
      '/usr/bin/log',
      [
        'show',
        '--style',
        'json',
        '--start',
        date(start),
        '--end',
        date(end),
        '--predicate',
        'process == "OpenLR" OR (process == "ReportCrash" AND eventMessage CONTAINS[c] "OpenLR")'
      ],
      { env: { ...process.env, TZ: 'UTC' }, timeout: 10000, maxBuffer: 2 * 1024 * 1024 }
    )
    const events = JSON.parse(stdout)
    const owned = events.filter((event) => (event.processID ?? event.processIdentifier) === pid)
    return {
      status: 'read',
      ownedEvents: owned.length,
      crashReporterEvents: events.filter(
        (event) => path.basename(event.processImagePath ?? '') === 'ReportCrash'
      ).length,
      faults: owned
        .filter((event) => /fault|error/i.test(event.messageType ?? ''))
        .slice(0, 20)
        .map((event) => ({
          subsystem: safeName(event.subsystem),
          category: safeName(event.category),
          type: safeName(event.messageType),
          markers: (event.eventMessage ?? '')
            .match(/\b(?:assertion|trap|exception|terminated|dispatch)\b/gi)
            ?.map((part) => part.toLowerCase())
        }))
    }
  } catch (error) {
    return { status: 'unavailable', code: error.code ?? null, signal: error.signal ?? null }
  }
}

const crashes = []
for (const trial of trials.filter(({ verified }) => !verified)) {
  const file = path.join(directory, `${trial.index}-${trial.candidate}.log`)
  const log = await readFile(file, 'utf8')
  const line = log.split(/\r?\n/).find((entry) => entry.startsWith(prefix))
  if (!line) continue
  const failure = JSON.parse(line.slice(prefix.length))
  const { pid, signal, exitedBeforeCleanup } = failure.host
  if (!exitedBeforeCleanup || signal !== 'SIGTRAP' || !Number.isSafeInteger(pid)) continue
  const { birthtimeMs, mtimeMs } = await stat(file)
  crashes.push({
    trial: trial.index,
    pid,
    immediateReport: failure.macCrash?.status,
    delayedReport: await findMacCrashReport(
      { pid, executable: 'OpenLR', startedWall: birthtimeMs, exitedWall: mtimeMs },
      { timeoutMs: 0 }
    ),
    unifiedLog: await unifiedLog(pid, birthtimeMs - 1000, mtimeMs + 5000)
  })
}
const result = { trials: trials.length, trapped: crashes.length, crashes }
await writeFile(path.join(directory, 'postmortem.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
