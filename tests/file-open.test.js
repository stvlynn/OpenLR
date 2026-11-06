import assert from 'node:assert/strict'
import { test } from 'node:test'
import { receiveOpenedFiles } from '../web/file-open.js'

const file = { name: 'private-input.png', base64: 'AQID', type: 'image/png', lastModified: 120 }

test(
  'file-open trace is opt-in and a stalled or rejected diagnostic does not prevent duplicate reopening',
  { timeout: 2000 },
  async (t) => {
    const requests = [],
      stages = [],
      commands = []
    t.after(() => {
      delete globalThis.openlrDiagnostics
      delete globalThis.mygo
    })
    globalThis.mygo = {
      call(method, ...args) {
        requests.push(method)
        if (method === 'Desktop.OpenedFiles') return Promise.resolve([file])
        assert.equal(method, 'Desktop.FileOpenMilestone')
        stages.push(args)
        if (args[1] === 'renderer-wake') throw Error('unavailable sink')
        if (args[1] === 'renderer-received') return Promise.reject(Error('failed sink'))
        return new Promise(() => {})
      }
    }
    const run = async (command, args) => {
      commands.push(command)
      if (command === 'view') return assert.deepEqual(args, { mode: 'detail' })
      assert.equal(command, 'import')
      assert.equal(args.files.length, 1)
      const [decoded] = args.files
      assert.equal(decoded.name, file.name)
      assert.equal(decoded.type, file.type)
      assert.equal(decoded.lastModified, file.lastModified)
      assert.deepEqual([...new Uint8Array(await decoded.arrayBuffer())], [1, 2, 3])
      return { added: [], existing: ['existing-photo-id'], failed: [] }
    }

    await receiveOpenedFiles(run, false)
    assert.deepEqual(requests, ['Desktop.OpenedFiles'])
    assert.deepEqual(commands, ['import', 'view'])
    globalThis.openlrDiagnostics = true
    await receiveOpenedFiles(run, true)
    assert.deepEqual(commands, ['import', 'view', 'import', 'view'])
    const attempt = stages[0][0]
    assert.ok(Number.isSafeInteger(attempt) && attempt > 0)
    assert.deepEqual(stages, [
      [attempt, 'renderer-wake', []],
      [attempt, 'renderer-received', [1]],
      [attempt, 'renderer-imported', [0, 1, 0]],
      [attempt, 'detail-finished', []]
    ])
  }
)

test('file-open trace reports failed stage without copying visible file errors into diagnostics', async (t) => {
  const stages = [],
    commands = []
  t.after(() => {
    delete globalThis.openlrDiagnostics
    delete globalThis.mygo
  })
  globalThis.openlrDiagnostics = true
  globalThis.mygo = {
    call(method, ...args) {
      if (method === 'Desktop.OpenedFiles') return Promise.resolve([file])
      stages.push(args)
      return Promise.resolve()
    }
  }
  await assert.rejects(
    receiveOpenedFiles(async (command) => {
      commands.push(command)
      return { added: [], existing: [], failed: [{ name: file.name, error: 'private error detail' }] }
    }, true),
    { message: 'private-input.png: private error detail' }
  )
  assert.deepEqual(commands, ['import'])
  const attempt = stages[0][0]
  assert.deepEqual(stages, [
    [attempt, 'renderer-wake', []],
    [attempt, 'renderer-received', [1]],
    [attempt, 'renderer-imported', [0, 0, 1]],
    [attempt, 'renderer-failed', []]
  ])
})
