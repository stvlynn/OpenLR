// The error listener is installed before the workspace module graph evaluates.
addEventListener(
  'error',
  (event) => {
    if (document.documentElement.dataset.agent || (!event.error && event.target?.tagName !== 'SCRIPT')) return
    const message = 'Could not open the workspace. ' + (event.message || 'A required module failed to load.')
    document.getElementById('notice').textContent = message
    globalThis.openlrStartupMilestone?.('renderer-script-failed')
  },
  true
)
if (globalThis.openlrDiagnostics) {
  const seen = new Set()
  globalThis.openlrStartupMilestone = (stage) => {
    if (seen.has(stage)) return
    seen.add(stage)
    // A diagnostic IPC failure must leave startup and command delivery alone.
    try {
      globalThis.mygo?.call?.('Desktop.StartupMilestone', stage)?.catch(() => {})
    } catch {}
  }
  globalThis.openlrStartupMilestone('renderer-script')
}
