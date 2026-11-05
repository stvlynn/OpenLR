import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { serveWorkspace } from './browser-server.mjs'

test('shared review GUI presents photo discussions while CLI retains structured data', async (t) => {
  const server = await serveWorkspace()
  t.after(server.close)
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  await page.goto(server.url)
  const result = await page.evaluate(async () => {
    const album = await window.openlr.run('album', { name: 'Autumn review' })
    const review = {
      id: album.id,
      title: album.name,
      revoked: false,
      photos: [{ id: 'internal-photo-id', name: 'Mountain at sunset.jpg' }],
      comments: [
        {
          id: 'internal-comment-id',
          photoId: 'internal-photo-id',
          name: 'Morgan',
          text: 'Keep the warmer sky.\n<img src=x onerror="window.injected=true">',
          created: '2026-11-05T10:30:00Z'
        }
      ],
      likes: { 'internal-photo-id': { 'internal-reviewer-id': 'Taylor' } }
    }
    window.reviewFixture = review
    window.mygo = {
      call: async (method) => {
        if (method === 'Sharing.Reviews') return JSON.stringify(review)
        throw Error('Unexpected adapter method ' + method)
      }
    }
    const result = await window.openlr.run('share-reviews', { album: album.id })
    document.querySelector('.album-sharing').open = true
    return { result, album: album.id }
  })
  const panel = page.locator('.album-reviews')
  assert.equal(await panel.locator('h3').textContent(), 'Autumn review')
  assert.equal(await panel.locator('h4').textContent(), 'Mountain at sunset.jpg')
  assert.match(await panel.textContent(), /1 like · Taylor/)
  assert.match(await panel.textContent(), /Morgan/)
  assert.match(await panel.textContent(), /Keep the warmer sky/)
  assert.doesNotMatch(await panel.textContent(), /internal-(photo|comment|reviewer)-id/)
  assert.equal(await panel.locator('img').count(), 0)
  assert.equal(await panel.locator('time').getAttribute('datetime'), '2026-11-05T10:30:00.000Z')
  assert.equal(result.result.comments[0].photoId, 'internal-photo-id')
  assert.deepEqual(result.result.likes, { 'internal-photo-id': { 'internal-reviewer-id': 'Taylor' } })
  assert.ok(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth))
  await panel.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '.workspace/sharing-reviews-ui.png' })
  await page.evaluate(async (id) => {
    window.reviewFixture.comments = []
    window.reviewFixture.likes = { 'internal-photo-id': {} }
    window.reviewFixture.revoked = true
    await window.openlr.run('share-reviews', { album: id })
  }, result.album)
  assert.match(await panel.textContent(), /No comments or likes yet/)
  assert.match(await panel.textContent(), /Album link revoked/)
  assert.equal(await panel.locator('article').count(), 0)
})
