import assert from 'node:assert/strict'
import test from 'node:test'
import { videoLoadOrder, videoTrialOutcome } from '../scripts/native-video-load-comparison.mjs'

test('packaged video comparison retains a failed trial and refuses another host without cleanup', () => {
  const passed = JSON.stringify({ nativeVideo: 'passed', preservedOriginalBytes: 27479 })
  const cleaned = JSON.stringify({ nativeVideoCleanup: 'confirmed' })
  const browser = JSON.stringify({ nativeVideoBrowser: '157.0.8103.38' })
  const success = videoTrialOutcome(0, null, `${browser}\n${passed}\n${cleaned}\n`)
  assert.equal(success.verified, true)
  assert.equal(success.browser, '157.0.8103.38')
  assert.equal(success.evidence.preservedOriginalBytes, 27479)
  assert.equal(videoTrialOutcome(1, null, `Import failed\n${cleaned}`).continueTrials, true)
  assert.equal(videoTrialOutcome(1, null, `Import failed\n${cleaned}`).verified, false)
  assert.equal(videoTrialOutcome(0, null, passed).continueTrials, false)
  assert.equal(videoTrialOutcome(null, 'SIGTERM', `${passed}\n${cleaned}`).continueTrials, false)
  assert.equal(videoTrialOutcome(0, null, cleaned).verified, false)
  assert.equal(videoLoadOrder.filter((candidate) => candidate === 'automatic').length, 8)
  assert.equal(videoLoadOrder.filter((candidate) => candidate === 'explicit').length, 8)
})
