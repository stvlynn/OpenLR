import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import path from 'node:path'

const commandTimeoutMs = 5_000
const commandBufferBytes = 4 * 1024 * 1024

// Only diagnostic subprocesses have timeouts. Observed processes are never signalled.
export function runResourceTool(command, args) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', timeout: commandTimeoutMs, maxBuffer: commandBufferBytes, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          command,
          args,
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          signal: error?.signal || null,
          errorCode: error ? String(error.code || 'EXECUTION_ERROR') : null,
          timedOut: Boolean(
            error?.killed &&
            error?.signal === 'SIGTERM' &&
            error?.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ),
          truncated: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          stdout: stdout || '',
          stderr: stderr || ''
        })
      }
    )
  })
}

export function ownedResourceProcesses(stdout, rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw Error('Invalid owned smoke process PID')
  const rows = []
  let malformedRows = 0
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim() || /^\s*PID\s+PPID\s+RSS\s+VSZ\s+STAT(?:E)?\s+/.test(line)) continue
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/)
    if (!match) {
      malformedRows++
      continue
    }
    const [pid, ppid, rssKiB, vszKiB] = match.slice(1, 5).map(Number)
    if (![pid, ppid, rssKiB, vszKiB].every(Number.isSafeInteger) || pid <= 0) {
      malformedRows++
      continue
    }
    // ps comm can contain a private absolute executable path. Retain its basename only.
    rows.push({ pid, ppid, rssKiB, vszKiB, state: match[5], command: path.posix.basename(match[6]) })
  }
  const owned = new Set(rows.some((row) => row.pid === rootPid) ? [rootPid] : [])
  let previousSize
  do {
    previousSize = owned.size
    for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid)
  } while (owned.size !== previousSize)
  return {
    rootPresent: owned.has(rootPid),
    malformedRows,
    processes: rows.filter((row) => owned.has(row.pid)).sort((a, b) => a.pid - b.pid)
  }
}

export async function collectSignalResources({
  rootPid,
  phase,
  rootAlive = true,
  platform = process.platform,
  run = runResourceTool
}) {
  const snapshot = {
    nativeSignalResources: 1,
    phase,
    timestamp: new Date().toISOString(),
    rootPid,
    rootAlive,
    platform,
    scope: 'current smoke process and descendants; system-wide memory counters',
    units: { rss: 'KiB', vsz: 'KiB', system: 'preserved in tool stdout' }
  }
  if (platform !== 'darwin') return { ...snapshot, status: 'unsupported-platform' }
  const commands = [
    ['ps', ['-axo', 'pid,ppid,rss,vsz,state,comm']],
    ['vm_stat', []],
    ['sysctl', ['hw.memsize', 'vm.swapusage']]
  ]
  const tools = await Promise.all(
    commands.map(async ([command, args]) => {
      try {
        return await run(command, args)
      } catch (error) {
        return {
          command,
          args,
          exitCode: null,
          errorCode: typeof error?.code === 'string' ? error.code : 'RUNNER_REJECTED',
          stdout: '',
          stderr: ''
        }
      }
    })
  )
  const [ps, ...system] = tools
  const { stdout, ...processTool } = ps
  const processSnapshot = rootAlive
    ? ownedResourceProcesses(stdout || '', rootPid)
    : { rootPresent: false, malformedRows: 0, processes: [] }
  // Never serialize the full process listing, including when ps fails or is truncated.
  return {
    ...snapshot,
    status: tools.every((tool) => tool.exitCode === 0 && !tool.errorCode && !tool.truncated)
      ? processSnapshot.malformedRows
        ? 'partial'
        : 'observed'
      : 'partial',
    ...processSnapshot,
    processTool,
    system,
    completedAt: new Date().toISOString()
  }
}

export async function startSignalResourceMonitor({
  filePath,
  rootPid,
  intervalMs = 5_000,
  platform = process.platform,
  run = runResourceTool,
  isRootAlive = () => true
}) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw Error('Invalid owned smoke process PID')
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw Error('Invalid resource poll interval')
  const output = await open(filePath, 'wx')
  let timer,
    active,
    stopped = false
  let writeFailure
  async function sample(phase) {
    try {
      const snapshot = await collectSignalResources({
        rootPid,
        phase,
        rootAlive: isRootAlive(),
        platform,
        run
      })
      // The smoke may have exited during ps. Do not follow a root PID after its owned child exits.
      if (!isRootAlive()) {
        snapshot.rootAlive = false
        snapshot.rootPresent = false
        snapshot.processes = []
      }
      await output.writeFile(JSON.stringify(snapshot) + '\n')
    } catch (error) {
      // A failed resource log must remain visible without interrupting the owned trial.
      writeFailure ||= error
      console.error('Native signal resource snapshot failed:', error)
    }
  }
  function poll(phase) {
    const started = performance.now()
    active = sample(phase).then(() => {
      if (!stopped)
        timer = setTimeout(() => poll('periodic'), Math.max(0, intervalMs - (performance.now() - started)))
    })
  }
  poll('start')
  let stopping
  return {
    stop() {
      return (stopping ||= (async () => {
        stopped = true
        clearTimeout(timer)
        try {
          await active
          await sample('end')
        } finally {
          await output.close()
        }
        if (writeFailure) throw writeFailure
      })())
    }
  }
}
