// The error listener is installed before the workspace module graph evaluates.
addEventListener(
  'error',
  (event) => {
    if (document.documentElement.dataset.agent || (!event.error && event.target?.tagName !== 'SCRIPT')) return
    const message = 'Could not open the workspace. ' + (event.message || 'A required module failed to load.')
    document.getElementById('notice').textContent = message
    globalThis.mygo?.call?.('Desktop.StartupError', message).catch(() => {})
  },
  true
)
