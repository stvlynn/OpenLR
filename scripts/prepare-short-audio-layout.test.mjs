// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  inspectContainer,
  prepareShortAudioLayout,
  validateContainerIndex
} from './prepare-short-audio-layout.mjs'

test('retained source produces packet-equivalent scale and gap-preserving layout arms', async () => {
  const prefix = path.join(os.tmpdir(), 'openlr-audio-layout-')
  const output = await mkdtemp(prefix)
  try {
    const source = await readFile(
      new URL('./fixtures/short-audio-layout/failed-multitrack.webm', import.meta.url)
    )
    const report = await prepareShortAudioLayout(output)
    assert.equal(report.verified, true)
    assert.equal(source.length, 59365)
    assert.deepEqual(await readFile(report.original.path), source)
    assert.deepEqual(
      report.reticked.clusters.map(({ timestampNs }) => timestampNs),
      report.original.clusters.map(({ timestampNs }) => timestampNs)
    )
    assert.deepEqual(
      report.regrouped.clusters.map(({ timestampNs }) => timestampNs),
      [0, 1360000000, 2000000000]
    )
    assert.deepEqual(
      report.regrouped.clusters.map(({ startsWithVideoRAP }) => startsWithVideoRAP),
      [true, false, true]
    )
    assert.deepEqual(report.tracks[2].gaps, [{ beforePacket: 40, durationNs: 200000000 }])
    assert.deepEqual(report.tracks[2].durationNs, [20000000])
    assert.ok(Object.values(report.preservation).every((value) => value === true))
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8')), report)
  } finally {
    assert.ok(path.resolve(output).startsWith(path.resolve(prefix)))
    await rm(output, { recursive: true, force: true })
  }
})

test('index validation rejects a CueRelativePosition that no longer points to a block', async () => {
  const source = await readFile(
    new URL('./fixtures/short-audio-layout/failed-multitrack.webm', import.meta.url)
  )
  const original = inspectContainer(source)
  validateContainerIndex(original)
  const { top, children } = original.structure
  const point = children(top.find(({ id }) => id === 0x1c53bb6b))[0]
  const position = children(point).find(({ id }) => id === 0xb7)
  const relative = children(position).find(({ id }) => id === 0xf0)
  source[relative.end - 1]++
  assert.throws(() => validateContainerIndex(inspectContainer(source)), /Cue relative position/)
})
