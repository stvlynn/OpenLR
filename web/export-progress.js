export const EXPORT_PROGRESS_MESSAGES = {
  cancel: 'Cancel export',
  cancelling: 'Cancelling…',
  progress: (completed, total) => `Exporting ${completed} of ${total}`,
  cancelled: (completed, total) => `Export cancelled · ${completed} of ${total} saved`,
  unknown: 'Export job not found',
  busy: 'An export is already running'
}

// Session-local lifecycle; this owns no photo edits, output paths or task queue.
export class ExportProgress {
  #record = null
  #controller = null
  #changed
  constructor(changed = () => {}) {
    this.#changed = changed
  }
  snapshot() {
    return this.#record ? structuredClone(this.#record) : null
  }
  #notify() {
    try {
      this.#changed(this.snapshot())
    } catch (error) {
      // Observation must not strand or fail an otherwise valid output operation.
      if (globalThis.reportError) globalThis.reportError(error)
      else console.error(error)
    }
  }
  start(total) {
    if (this.#controller) throw Error(EXPORT_PROGRESS_MESSAGES.busy)
    const controller = (this.#controller = new AbortController())
    const id = crypto.randomUUID()
    this.#record = {
      id,
      status: 'running',
      phase: 'validating',
      total,
      completed: 0,
      current: null,
      writtenBytes: 0,
      totalBytes: 0,
      files: []
    }
    this.#notify()
    return {
      id,
      signal: controller.signal,
      update: (changes) => {
        Object.assign(this.#record, changes)
        this.#notify()
      }
    }
  }
  finish(status, error) {
    Object.assign(this.#record, { status, phase: 'finished', current: null, writtenBytes: 0, totalBytes: 0 })
    if (error) this.#record.error = { message: error.message, ...error.details }
    this.#controller = null
    this.#notify()
  }
  cancel(id) {
    if (!this.#record || id !== this.#record.id) throw Error(EXPORT_PROGRESS_MESSAGES.unknown)
    if (this.#controller && !this.#controller.signal.aborted) {
      this.#record.status = 'cancelling'
      this.#controller.abort()
      this.#notify()
    }
    return this.snapshot()
  }
}
