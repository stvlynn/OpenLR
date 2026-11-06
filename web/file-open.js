import { decodeFile } from './transfer.js'

let nextAttempt = 0

function mark(attempt, stage, counts = []) {
  if (attempt === undefined) return
  try {
    globalThis.mygo.call('Desktop.FileOpenMilestone', attempt, stage, counts)?.catch(() => {})
  } catch {
    // Keep diagnostics independent of the file-open result and its notice.
  }
}

export async function receiveOpenedFiles(run, wake) {
  const attempt = globalThis.openlrDiagnostics && nextAttempt < 128 ? ++nextAttempt : undefined
  mark(attempt, wake ? 'renderer-wake' : 'startup-drain')
  try {
    const chosen = await globalThis.mygo.call('Desktop.OpenedFiles')
    mark(attempt, 'renderer-received', [chosen?.length ?? 0])
    if (!chosen?.length) return
    const { failed, added, existing } = await run('import', { files: chosen.map(decodeFile) })
    mark(attempt, 'renderer-imported', [added.length, existing.length, failed.length])
    if (added.length || existing.length) {
      await run('view', { mode: 'detail' })
      mark(attempt, 'detail-finished')
    }
    if (failed.length) throw Error(failed.map((f) => f.name + ': ' + f.error).join(', '))
  } catch (error) {
    mark(attempt, 'renderer-failed')
    throw error
  }
}
