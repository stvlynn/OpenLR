import assert from 'node:assert/strict'
import test from 'node:test'
import {
  videoDecoderOrder,
  videoLoadOrder,
  videoPauseOrder,
  videoPosterOrder,
  videoTrialOutcome
} from '../scripts/native-video-load-comparison.mjs'

test('packaged video comparisons each schedule four fixed ABBA blocks', () => {
  for (const [order, control, candidate] of [
    [videoLoadOrder, 'automatic', 'explicit'],
    [videoPauseOrder, 'frame-first', 'anchor-first'],
    [videoDecoderOrder, 'default-decoder', 'software-decoder'],
    [videoPosterOrder, 'native-poster', 'decoded-poster']
  ]) {
    assert.equal(order.length, 16)
    for (let offset = 0; offset < order.length; offset += 4) {
      assert.deepEqual(order.slice(offset, offset + 4), [control, candidate, candidate, control])
    }
  }
})

test('packaged video comparison retains a failed trial and refuses another host without cleanup', () => {
  const passed = JSON.stringify({ nativeVideo: 'passed', preservedOriginalBytes: 27479 })
  const hostCleaned = JSON.stringify({ nativeVideoCleanup: 'confirmed' })
  const oracleCleaned = JSON.stringify({ nativeVideoOracleCleanup: 'confirmed' })
  const cleaned = `${hostCleaned}\n${oracleCleaned}`
  const browser = JSON.stringify({ nativeVideoBrowser: '157.0.8103.38' })
  const success = videoTrialOutcome(0, null, `${browser}\n${passed}\n${cleaned}\n`)
  assert.equal(success.verified, true)
  assert.equal(success.browser, '157.0.8103.38')
  assert.equal(success.evidence.preservedOriginalBytes, 27479)
  assert.equal(success.oracleCleanupConfirmed, true)
  assert.equal(videoTrialOutcome(1, null, `Import failed\n${cleaned}`).continueTrials, true)
  assert.equal(videoTrialOutcome(1, null, `Import failed\n${cleaned}`).verified, false)
  assert.equal(videoTrialOutcome(0, null, passed).continueTrials, false)
  assert.equal(videoTrialOutcome(0, null, `${passed}\n${hostCleaned}`).continueTrials, false)
  assert.equal(videoTrialOutcome(0, null, `${passed}\n${oracleCleaned}`).continueTrials, false)
  assert.equal(videoTrialOutcome(null, 'SIGTERM', `${passed}\n${cleaned}`).continueTrials, false)
  assert.equal(videoTrialOutcome(0, null, cleaned).verified, false)
})
