// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import path from 'node:path'

export function runResourceTool(command, args, { timeoutMs = 5000 } = {}) {
  const started = performance.now()
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) =>
        resolve({
          command,
          args,
          elapsedMs: performance.now() - started,
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          signal: error?.signal ?? null,
          errorCode: error ? String(error.code ?? 'EXECUTION_ERROR') : null,
          timedOut: Boolean(
            error?.killed &&
            error?.signal === 'SIGKILL' &&
            error?.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ),
          truncated: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          stdout: stdout ?? '',
          stderr: stderr ?? ''
        })
    )
  })
}

export function summarizeProcesses(stdout, rootPid, currentUid = process.getuid?.() ?? null) {
  assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0, 'Expected an owned driver PID')
  const rows = []
  let malformedRows = 0
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim() || /^\s*PID\s+PPID\s+UID\s+RSS\s+VSZ\s+STAT(?:E)?\s+/.test(line)) continue
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/)
    if (!match) {
      malformedRows++
      continue
    }
    const [pid, ppid, uid, rssKiB, vszKiB] = match.slice(1, 6).map(Number)
    if (![pid, ppid, uid, rssKiB, vszKiB].every(Number.isSafeInteger) || pid <= 0) {
      malformedRows++
      continue
    }
    rows.push({ pid, ppid, uid, rssKiB, vszKiB, state: match[6], command: path.posix.basename(match[7]) })
  }
  const owned = new Set(rows.some(({ pid }) => pid === rootPid) ? [rootPid] : [])
  let previous
  do {
    previous = owned.size
    for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid)
  } while (previous !== owned.size)
  const groups = {
    openlr: /^OpenLR$/i,
    chrome: /^(Google Chrome|Chromium|chrome)/i,
    webkit: /^(com\.apple\.WebKit|WebKit)/,
    videoToolbox: /^(VT.*XPCService|com\.apple\.(VT|VideoToolbox))/,
    mediaServices: /^(coreaudiod|mediaserverd|mediaremoted)$/
  }
  return {
    malformedRows,
    rootPresent: owned.has(rootPid),
    system: {
      processCount: rows.length,
      currentUserProcessCount:
        currentUid === null ? null : rows.filter(({ uid }) => uid === currentUid).length,
      zombies: rows.filter(({ state }) => state.includes('Z')).length,
      rssKiBSum: rows.reduce((sum, row) => sum + row.rssKiB, 0)
    },
    ownedTree: rows.filter(({ pid }) => owned.has(pid)).map(({ uid, ...row }) => row),
    serviceGroups: Object.fromEntries(
      Object.entries(groups).map(([name, expression]) => {
        const selected = rows.filter(({ command }) => expression.test(command))
        return [
          name,
          { count: selected.length, rssKiBSum: selected.reduce((sum, row) => sum + row.rssKiB, 0) }
        ]
      })
    )
  }
}

export async function startCohortResourceObserver({
  filePath,
  rootPid = process.pid,
  platform = process.platform,
  currentUid = process.getuid?.() ?? null,
  run = runResourceTool
} = {}) {
  const output = await open(filePath, 'wx')
  const started = performance.now()
  let tail = Promise.resolve(),
    closing,
    closed = false
  const commands = [
    ['/bin/ps', ['-ww', '-axo', 'pid,ppid,uid,rss,vsz,state,comm']],
    ['/usr/bin/vm_stat', []],
    [
      '/usr/sbin/sysctl',
      ['hw.memsize', 'vm.swapusage', 'kern.num_files', 'kern.maxfiles', 'kern.maxproc', 'kern.maxprocperuid']
    ],
    ...['custom', 'assertions', 'systemstate', 'stats'].map((option) => ['/usr/bin/pmset', ['-g', option]]),
    ['/usr/bin/pmset', ['-g', 'powerstate', 'IODisplayWrangler']],
    ['/bin/sh', ['-c', 'ulimit -S -u\nulimit -H -u']]
  ]
  async function collect(context) {
    const begin = performance.now()
    const record = {
      nativeCohortResources: 1,
      ...context,
      timestamp: new Date().toISOString(),
      cohortElapsedMs: begin - started,
      rootPid,
      platform,
      scope:
        'Owned driver tree; system-wide counters and named service aggregates are not ownership claims. RSS sums double-count shared pages; boundary samples omit peaks.',
      units: {
        rss: 'KiB',
        vsz: 'KiB',
        vm_stat: 'pages; page-size banner retained',
        system: 'raw native tool units'
      }
    }
    if (platform !== 'darwin') record.status = 'unsupported-platform'
    else {
      const results = await Promise.all(
        commands.map(async ([command, args]) => {
          try {
            const result = await run(command, args)
            if (
              command === '/usr/bin/pmset' &&
              args[0] === '-g' &&
              args[1] === 'powerstate' &&
              /(?:^|\n)Internal failure:\s*Failed to get power state information\s*(?:\n|$)/.test(
                result.stdout ?? ''
              )
            ) {
              return {
                ...result,
                semanticStatus: 'unavailable',
                semanticErrorCode: 'PMSET_POWERSTATE_UNAVAILABLE'
              }
            }
            return result
          } catch (error) {
            return {
              command,
              args,
              exitCode: null,
              errorCode: String(error?.code ?? 'RUNNER_REJECTED'),
              stdout: '',
              stderr: error?.name ?? 'Error'
            }
          }
        })
      )
      const [{ stdout, ...processTool }, ...systemTools] = results
      const processes = summarizeProcesses(stdout ?? '', rootPid, currentUid)
      Object.assign(record, {
        processes,
        processTool,
        systemTools,
        status:
          results.every(
            (result) =>
              result.exitCode === 0 && !result.errorCode && !result.truncated && !result.semanticErrorCode
          ) && !processes.malformedRows
            ? 'observed'
            : 'partial'
      })
    }
    record.elapsedMs = performance.now() - begin
    record.completedAt = new Date().toISOString()
    await output.writeFile(JSON.stringify(record) + '\n')
    return record
  }
  return {
    sample(context) {
      assert.equal(closed, false, 'Resource observer is closing')
      // Serialize complete snapshots, including their writes; do not overlap polls.
      const next = tail.then(() => collect(context))
      tail = next
      return next
    },
    close() {
      if (!closing) {
        closed = true
        closing = (async () => {
          try {
            await tail
          } finally {
            await output.close()
          }
        })()
      }
      return closing
    }
  }
}
