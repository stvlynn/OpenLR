import {
  normalizeExportSettings,
  loadExportSettings,
  saveExportSettingsBatch,
  EXPORT_SETTINGS_MESSAGES
} from './export-settings.js'
import { isVideo } from './video.js'
import { validateDngSource } from './dng.js'

export const BATCH_EXPORT_MESSAGES = {
  action: (count) => (count > 1 ? `Export ${count}` : 'Export'),
  title: (count) => (count > 1 ? `Export ${count} files` : 'Export photo'),
  complete: (count) => `Exported ${count} files`,
  empty: 'Select photos to export',
  invalid: 'Choose unique photos from the current view',
  previousOptions: 'Previous export settings cannot be combined with new export options',
  failed: (completed, total, name, message) => `Exported ${completed} of ${total} files. ${name}: ${message}`
}

// Capture recipes and order, without moving the editor's active source or history.
export async function exportSelection(options) {
  const job = options.progress?.start(options.args.ids?.length ?? options.selection.size)
  try {
    const result = await performExportSelection({ ...options, job })
    options.progress?.finish(result.cancelled ? 'cancelled' : 'completed')
    return job ? { ...result, jobId: job.id } : result
  } catch (error) {
    if (job) {
      error.details = { ...error.details, jobId: job.id }
      options.progress.finish('failed', error)
    }
    throw error
  }
}

async function performExportSelection({
  visible,
  selection,
  args,
  original,
  prepare,
  openFolder,
  reservedFolder,
  job
}) {
  const { ids = [...selection], previous = false, outputDirectory, ...options } = args
  const files = []
  const signal = job?.signal
  let folder,
    current,
    items = [],
    failure,
    folderClosed = false
  const exportError = (error) => {
    const details = {
      completed: files.length,
      total: ids.length,
      files,
      failed: current ? { id: current.id, name: current.name } : null
    }
    if (error.cleanupError) details.cleanupError = error.cleanupError
    return Object.assign(
      Error(
        BATCH_EXPORT_MESSAGES.failed(files.length, details.total, current?.name ?? 'Export', error.message)
      ),
      { code: error.code ?? 'EXPORT_FAILED', details }
    )
  }
  try {
    signal?.throwIfAborted()
    if (!ids.length) throw Error(BATCH_EXPORT_MESSAGES.empty)
    const chosen = new Set(ids)
    if (chosen.size !== ids.length || ids.some((id) => !visible.some((photo) => photo.id === id)))
      throw Error(BATCH_EXPORT_MESSAGES.invalid)
    if (previous && Object.keys(options).length) throw Error(BATCH_EXPORT_MESSAGES.previousOptions)
    const remembered = previous ? loadExportSettings() : null
    for (const photo of visible.filter((photo) => chosen.has(photo.id))) {
      current = photo
      const captured = structuredClone(photo),
        media = isVideo(photo) ? 'video' : 'photo'
      if (previous && !remembered[media])
        throw Object.assign(Error(EXPORT_SETTINGS_MESSAGES.missing), { code: 'EXPORT_SETTINGS_MISSING' })
      items.push({
        photo: captured,
        media,
        options: normalizeExportSettings(previous ? remembered[media] : options, media)
      })
    }
    // Validate known format/source incompatibilities before the first file write.
    // Decoder/read errors discovered later remain honest partial failures.
    for (const item of items) {
      signal?.throwIfAborted()
      current = item.photo
      if (current.local?.sidecarError) throw Error(current.local.sidecarError)
      if (item.options.format === 'image/x-adobe-dng')
        await validateDngSource((await original(current.id)).file)
    }
    current = null
    signal?.throwIfAborted()
    job?.update({ phase: 'choosing' })
    folder = await (reservedFolder ?? openFolder())
    if (!folder) return { files, total: items.length, cancelled: true }
    for (const item of items) {
      signal?.throwIfAborted()
      current = item.photo
      job?.update({
        phase: 'preparing',
        current: { id: current.id, name: current.name },
        writtenBytes: 0,
        totalBytes: 0
      })
      // Let the UI and control lane run before the next synchronous codec/render phase.
      await new Promise((resolve) => setTimeout(resolve, 0))
      signal?.throwIfAborted()
      const prepared = await prepare(current, item.options, { original })
      signal?.throwIfAborted()
      job?.update({ phase: 'writing', totalBytes: prepared.blob.size })
      const saved = await folder.write(prepared.blob, prepared.filename, {
        signal,
        onProgress: (bytes) => job?.update(bytes)
      })
      files.push({ id: current.id, ...saved })
      job?.update({ completed: files.length, files: [...files] })
    }
    current = null
    signal?.throwIfAborted()
    job?.update({ phase: 'finishing' })
    folderClosed = true
    await folder.close()
    signal?.throwIfAborted()
    try {
      saveExportSettingsBatch(items)
    } catch (error) {
      throw Error(EXPORT_SETTINGS_MESSAGES.rememberFailed + error.message)
    }
    return { files, total: items.length, cancelled: false }
  } catch (error) {
    if (signal?.aborted && error === signal.reason && !error.cleanupError)
      return { files, total: items.length || ids.length, cancelled: true }
    failure = exportError(error)
    throw failure
  } finally {
    if (!folderClosed) {
      try {
        if (!folder && reservedFolder) folder = await reservedFolder
        await folder?.close()
      } catch (error) {
        if (failure) failure.details.cleanupError = error.message
        else throw exportError(error)
      }
    }
  }
}
