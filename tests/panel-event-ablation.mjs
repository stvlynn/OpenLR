import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
// Synthetic activation in one browser task isolates toggle coalescing. Trusted
// mouse and keyboard behavior is verified separately in panel-state.test.js.
const browser = await chromium.launch({ channel: 'chrome' })
try {
  const page = await browser.newPage()
  for (const variant of ['native-only', 'toggle-observer', 'queued-click']) {
    await page.setContent('<details><summary>Panel</summary><input aria-label="Value"></details>')
    const result = await page.evaluate(async (variant) => {
      const detail = document.querySelector('details'),
        summary = document.querySelector('summary')
      const notifications = [],
        requests = []
      let queue = Promise.resolve()
      if (variant === 'toggle-observer')
        detail.addEventListener('toggle', () => notifications.push(detail.open))
      if (variant === 'queued-click')
        summary.addEventListener('click', (event) => {
          event.preventDefault()
          requests.push('panel')
          queue = queue.then(() => {
            detail.open = !detail.open
            notifications.push(detail.open)
          })
        })
      summary.click()
      summary.click()
      await queue
      await new Promise((resolve) => setTimeout(resolve, 0))
      return { finalOpen: detail.open, notifications, requests }
    }, variant)
    console.log(JSON.stringify({ variant, ...result }))
    assert.equal(result.finalOpen, false)
    assert.deepEqual(
      result.notifications,
      variant === 'queued-click' ? [true, false] : variant === 'toggle-observer' ? [false] : []
    )
  }
  console.log('Chrome ' + browser.version())
} finally {
  await browser.close()
}
