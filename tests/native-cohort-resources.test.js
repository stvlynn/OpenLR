// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import {
  runResourceTool,
  startCohortResourceObserver,
  summarizeProcesses
} from '../scripts/native-cohort-resources.mjs'
import { runVideoTrials } from '../scripts/native-video-trials.mjs'

const listing = ` PID PPID UID RSS VSZ STAT COMM
10 1 501 20 100 S /private/user/driver
11 10 501 30 200 S /private/session/OpenLR
12 11 501 40 300 S /Applications/Google Chrome for Testing
20 1 0 50 400 S /System/com.apple.WebKit.WebContent
21 1 0 60 500 Z /private/unrelated/personal-app
`

test('resource process output keeps only the owned tree and aggregate system/service counters', () => {
  const result = summarizeProcesses(listing, 10, 501)
  assert.deepEqual(
    result.ownedTree.map(({ pid, command }) => [pid, command]),
    [
      [10, 'driver'],
      [11, 'OpenLR'],
      [12, 'Google Chrome for Testing']
    ]
  )
  assert.deepEqual(result.system, { processCount: 5, currentUserProcessCount: 3, zombies: 1, rssKiBSum: 200 })
  assert.equal(JSON.stringify(result).includes('"uid"'), false)
  assert.deepEqual(result.serviceGroups.webkit, { count: 1, rssKiBSum: 50 })
  assert.equal(JSON.stringify(result).includes('/private/'), false)
  assert.equal(JSON.stringify(result).includes('personal-app'), false)
  assert.equal(summarizeProcesses(listing + 'malformed\n', 10).malformedRows, 1)
  assert.throws(() => summarizeProcesses(listing, 0), /owned driver PID/)
})

test('boundary snapshots serialize, preserve power/file-counter failures and finish before close', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openlr-cohort-resources-'))
  assert.equal(path.dirname(root), path.resolve(tmpdir()))
  try {
    let active = 0,
      maximum = 0
    const calls = []
    const run = async (command, args) => {
      active++
      maximum = Math.max(maximum, active)
      calls.push([command, args])
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      const failed = args.includes('systemstate')
      return {
        command,
        args,
        exitCode: failed ? 1 : 0,
        errorCode: failed ? '1' : null,
        stdout:
          command === '/bin/ps'
            ? listing
            : command.endsWith('vm_stat')
              ? 'page size of 16384 bytes\nPages free: 2.\n'
              : 'native output\n',
        stderr: failed ? 'unsupported getter' : ''
      }
    }
    const file = path.join(root, 'resources.jsonl')
    const observer = await startCohortResourceObserver({
      filePath: file,
      rootPid: 10,
      platform: 'darwin',
      run
    })
    const before = observer.sample({ phase: 'before-trial', index: 0 })
    const after = observer.sample({
      phase: 'after-trial',
      index: 0,
      cleanupConfirmed: true,
      oracleCleanupConfirmed: false
    })
    await observer.close()
    const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal((await before).status, 'partial')
    assert.equal((await after).status, 'partial')
    assert.deepEqual(
      records.map(({ phase }) => phase),
      ['before-trial', 'after-trial']
    )
    assert.equal(records[1].oracleCleanupConfirmed, false)
    assert.equal(calls.length, 18)
    assert.equal(maximum, 9)
    assert.equal(active, 0)
    assert.ok(calls.some(([command, args]) => command.endsWith('sysctl') && args.includes('kern.num_files')))
    assert.ok(
      calls.some(([command, args]) => command.endsWith('pmset') && args.includes('IODisplayWrangler'))
    )
    assert.ok(
      calls.some(([command, args]) => command === '/bin/sh' && args[1] === 'ulimit -S -u\nulimit -H -u')
    )
    assert.ok(records[0].systemTools.some(({ stderr }) => stderr === 'unsupported getter'))
    assert.ok(records[0].systemTools.some(({ stdout }) => stdout.includes('16384')))
    assert.equal(JSON.stringify(records).includes('/private/'), false)
    assert.throws(() => observer.sample({ phase: 'late' }), /closing/)
    const unsupportedFile = path.join(root, 'unsupported.jsonl')
    const unsupported = await startCohortResourceObserver({
      filePath: unsupportedFile,
      platform: 'win32',
      run: () => assert.fail('No macOS commands on Windows')
    })
    assert.equal((await unsupported.sample({ phase: 'before-trial' })).status, 'unsupported-platform')
    await unsupported.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('diagnostic command timeout applies only to the actual owned subprocess and keeps failures visible', async () => {
  const result = await runResourceTool(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 50
  })
  assert.equal(result.timedOut, true)
  assert.equal(result.signal, 'SIGKILL')
  const missing = await runResourceTool('openlr-no-such-resource-tool', [])
  assert.equal(missing.errorCode, 'ENOENT')
})

test('shared driver records both resource boundaries and still stops on unconfirmed cleanup', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openlr-cohort-driver-'))
  assert.equal(path.dirname(root), path.resolve(tmpdir()))
  const spawn = childProcess.spawn
  const previous = process.env.OPENLR_COHORT_RESOURCES
  const children = []
  process.env.OPENLR_COHORT_RESOURCES = '1'
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    const child = spawn(
      command,
      [
        '-e',
        `for(const line of JSON.parse(process.env.RESOURCE_TEST_RECORDS)) console.log(JSON.stringify(line))`
      ],
      options
    )
    children.push(child)
    return child
  })
  syncBuiltinESMExports()
  try {
    const records = [
      { nativeVideo: 'passed' },
      { nativeVideoCleanup: 'confirmed' },
      { nativeVideoOracleCleanup: 'confirmed' }
    ]
    await assert.rejects(
      runVideoTrials({
        apps: { pass: process.execPath, gate: process.execPath },
        order: ['pass', 'gate', 'pass'],
        destination: root,
        environments: {
          pass: { RESOURCE_TEST_RECORDS: JSON.stringify(records) },
          gate: { RESOURCE_TEST_RECORDS: JSON.stringify(records.slice(0, 2)) }
        }
      }),
      /cleanup was not confirmed/
    )
    const report = JSON.parse(await readFile(path.join(root, 'report.json')))
    assert.equal(report.complete, false)
    assert.equal(report.trials.length, 2)
    assert.equal(report.trials[0].verified, true)
    assert.equal(report.trials[1].continueTrials, false)
    assert.ok(
      report.trials.every(({ observationMs }) => observationMs.before >= 0 && observationMs.after >= 0)
    )
    assert.ok(children.every((child) => child.exitCode === 0 && child.signalCode === null))
    const snapshots = (await readFile(path.join(root, 'cohort-resources.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
    assert.deepEqual(
      snapshots.map(({ phase, index }) => [phase, index]),
      [
        ['before-trial', 0],
        ['after-trial', 0],
        ['before-trial', 1],
        ['after-trial', 1]
      ]
    )
    assert.equal(snapshots[3].oracleCleanupConfirmed, false)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    if (previous === undefined) delete process.env.OPENLR_COHORT_RESOURCES
    else process.env.OPENLR_COHORT_RESOURCES = previous
    await rm(root, { recursive: true, force: true })
  }
})
