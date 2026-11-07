import assert from 'node:assert/strict'
import test from 'node:test'
import { parseStackProbeRecords, validateStackProbeRecords } from '../scripts/compare-jsc-stacks.mjs'

function records(mode = 'native-c') {
  const bounds = { pthreadLow: '0x1000', pthreadOrigin: '0x9000', pthreadSize: 32768 }
  const events = [
    { event: 'loaded-image', jscUUID: 'A6079469-BB25-38B3-B603-D712B7DBB43D' },
    { event: 'mutator-native-stack', sp: '0x8000', ...bounds },
    { event: 'setup-returned' },
    ...(mode === 'native-c' ? [] : [{ event: 'callback-entry' }]),
    { event: 'waiting-stack', sp: mode === 'go-busy' ? '0x20000' : '0x7000', ...bounds },
    { event: 'collection-started' },
    { event: 'collection-returned', api: 'JSGarbageCollect', synchronous: false },
    {
      event: 'exposure-ended',
      windowLimitMs: 6000,
      iterationLimit: 256,
      iterations: 12,
      gcFinalizationObserved: true,
      finalizersBeforeContextRelease: 8
    },
    { event: 'completed', ready: 1, done: 1, collectorJoined: true }
  ]
  return events.map((record) => ({ pid: 42, mode, ...record }))
}

test('generated native and Go stack records retain the observed boundary', () => {
  for (const mode of ['native-c', 'go-busy', 'go-to-c']) {
    const value = records(mode)
    const stdout =
      'unrelated output\n' + value.map((r) => 'OpenLR JSC stack probe ' + JSON.stringify(r)).join('\n')
    const parsed = parseStackProbeRecords(stdout, 42, mode)
    assert.equal(
      validateStackProbeRecords(parsed, { normalExit: true }).withinNativeBounds,
      mode !== 'go-busy'
    )
    assert.throws(() => parseStackProbeRecords(stdout, 43, mode), /another process/)
  }
})

test('API return alone cannot verify native GC activity', () => {
  const value = records()
  value.find((r) => r.event === 'exposure-ended').gcFinalizationObserved = false
  assert.throws(() => validateStackProbeRecords(value, { normalExit: true }), /actual GC activity/)
  value.find((r) => r.event === 'exposure-ended').gcFinalizationObserved = true
  value.find((r) => r.event === 'exposure-ended').finalizersBeforeContextRelease = 0
  assert.throws(() => validateStackProbeRecords(value, { normalExit: true }))
})

test('mismatched image, stack, or completion ordering cannot pass', () => {
  const altered = records()
  altered[0].jscUUID = '00000000-0000-0000-0000-000000000000'
  assert.throws(() => validateStackProbeRecords(altered, { normalExit: true }), /identity/)
  const wrongStack = records('go-busy')
  wrongStack.find((r) => r.event === 'waiting-stack').sp = '0x7000'
  assert.throws(() => validateStackProbeRecords(wrongStack, { normalExit: true }), /different stack/)
  const wrongOrder = records()
  wrongOrder.splice(3, 0, wrongOrder.pop())
  assert.throws(() => validateStackProbeRecords(wrongOrder, { normalExit: true }))
})

test('a fault during collection permits incomplete GC evidence, not missing readiness', () => {
  const fault = records('go-busy').filter(
    (r) => !['collection-returned', 'exposure-ended', 'completed'].includes(r.event)
  )
  assert.equal(validateStackProbeRecords(fault, { normalExit: false }).withinNativeBounds, false)
  assert.throws(() =>
    validateStackProbeRecords(
      fault.filter((r) => r.event !== 'waiting-stack'),
      { normalExit: false }
    )
  )
})
