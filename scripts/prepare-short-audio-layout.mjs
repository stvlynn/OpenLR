// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as media from '../web/vendor/mediabunny/mediabunny.mjs'

const fixture = fileURLToPath(
  new URL('./fixtures/short-audio-layout/failed-multitrack.webm', import.meta.url)
)

// The retained input has no
// lacing or unknown-sized elements; unsupported shapes fail explicitly.
export function inspectContainer(bytes) {
  function vint(offset, id = false) {
    let length = 1,
      marker = 0x80
    while (!(bytes[offset] & marker)) {
      marker >>= 1
      assert.ok(++length <= 8, 'Invalid fixture EBML integer')
    }
    assert.ok(offset + length <= bytes.length)
    let value = BigInt(id ? bytes[offset] : bytes[offset] & (marker - 1))
    for (let i = 1; i < length; i++) value = value * 256n + BigInt(bytes[offset + i])
    assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER), 'Fixture EBML value must be exact')
    return { length, value: Number(value) }
  }
  function elements(start, end) {
    const entries = []
    for (let offset = start; offset < end;) {
      const id = vint(offset, true),
        size = vint(offset + id.length)
      const data = offset + id.length + size.length,
        next = data + size.value
      assert.ok(next <= end, 'Invalid fixture EBML extent')
      entries.push({ id: id.value, offset, data, end: next })
      offset = next
    }
    return entries
  }
  const children = (element) => elements(element.data, element.end)
  const unsigned = (element) => {
    let value = 0
    for (let i = element.data; i < element.end; i++) value = value * 256 + bytes[i]
    assert.ok(Number.isSafeInteger(value))
    return value
  }
  const signed = (element) => {
    let value = BigInt.asIntN(8, BigInt(bytes[element.data]))
    for (let i = element.data + 1; i < element.end; i++) value = value * 256n + BigInt(bytes[i])
    assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER))
    return Number(value)
  }
  const segment = elements(0, bytes.length).find(({ id }) => id === 0x18538067)
  assert.ok(segment, 'Expected a Matroska Segment')
  const top = children(segment)
  const info = children(top.find(({ id }) => id === 0x1549a966))
  const timestampScaleNs = unsigned(info.find(({ id }) => id === 0x2ad7b1))
  const tracks = top.find(({ id }) => id === 0x1654ae6b)
  const trackTiming = children(tracks).map((entry) => {
    const fields = children(entry)
    const value = (id, fallback = 0) => {
      const element = fields.find((entry) => entry.id === id)
      return element ? unsigned(element) : fallback
    }
    return { number: value(0xd7), codecDelayNs: value(0x56aa), seekPreRollNs: value(0x56bb) }
  })
  const clusters = top
    .filter(({ id }) => id === 0x1f43b675)
    .map((entry) => {
      const fields = children(entry)
      const timestampNs = unsigned(fields.find(({ id }) => id === 0xe7)) * timestampScaleNs
      const blocks = fields.flatMap((field) => {
        const group = field.id === 0xa0 ? children(field) : null
        const block = group ? group.find(({ id }) => id === 0xa1) : field.id === 0xa3 ? field : null
        if (!block) return []
        const track = vint(block.data),
          relative = bytes.readInt16BE(block.data + track.length)
        const flags = bytes[block.data + track.length + 2]
        assert.equal(flags & 6, 0, 'This fixture must remain unlaced')
        const discard = group?.find(({ id }) => id === 0x75a2)
        const duration = group?.find(({ id }) => id === 0x9b)
        return [
          {
            track: track.value,
            timestampNs: timestampNs + relative * timestampScaleNs,
            key: group ? !group.some(({ id }) => id === 0xfb) : Boolean(flags & 0x80),
            discardPaddingNs: discard ? signed(discard) : 0,
            durationNs: duration ? unsigned(duration) * timestampScaleNs : null,
            referencesNs:
              group?.filter(({ id }) => id === 0xfb).map((field) => signed(field) * timestampScaleNs) ?? [],
            data: bytes.subarray(block.data + track.length + 3, block.end),
            element: field,
            payloadElement: block,
            group
          }
        ]
      })
      return { timestampNs, blocks, element: entry }
    })
  return {
    timestampScaleNs,
    tracks: bytes.subarray(tracks.offset, tracks.end),
    trackTiming,
    clusters,
    blocks: trackTiming.map(({ number }) =>
      clusters.flatMap(({ blocks }) => blocks.filter(({ track }) => track === number))
    ),
    structure: { bytes, top, info, segment, elements, children, unsigned, signed, vint }
  }
}

const inputFor = (bytes) =>
  new media.Input({ source: new media.BufferSource(bytes), formats: media.ALL_FORMATS })
const ns = (seconds) => Math.round(seconds * 1e9)

export async function readPackets(input) {
  return Promise.all(
    (await input.getTracks()).map(async (track) => {
      const packets = []
      for await (const packet of new media.EncodedPacketSink(track).packets()) packets.push(packet)
      return { track, packets, decoderConfig: await track.getDecoderConfig() }
    })
  )
}

export function validateContainerIndex(container) {
  const { top, segment, children, unsigned, bytes } = container.structure
  const seeks = children(top.find(({ id }) => id === 0x114d9b74)).map((entry) => {
    const fields = children(entry)
    const id = unsigned(fields.find(({ id }) => id === 0x53ab))
    const offset = unsigned(fields.find(({ id }) => id === 0x53ac)) + segment.data
    assert.ok(
      top.some((element) => element.offset === offset && element.id === id),
      'SeekHead target does not resolve'
    )
    return id
  })
  const cues = children(top.find(({ id }) => id === 0x1c53bb6b)).flatMap((point) => {
    const fields = children(point)
    const timestampNs = unsigned(fields.find(({ id }) => id === 0xb3)) * container.timestampScaleNs
    return fields
      .filter(({ id }) => id === 0xb7)
      .map((position) => {
        const values = children(position)
        const value = (id) => unsigned(values.find((entry) => entry.id === id))
        const cluster = container.clusters.find(
          ({ element }) => element.offset === segment.data + value(0xf1)
        )
        assert.ok(cluster, 'Cue cluster does not resolve')
        const block = cluster.blocks.find(
          ({ element }) => element.offset === cluster.element.data + value(0xf0)
        )
        assert.ok(block, 'Cue relative position does not resolve to a Block')
        assert.equal(block.track, value(0xf7), 'Cue track does not match its Block')
        assert.equal(block.timestampNs, timestampNs, 'Cue timestamp does not match its Block')
        return { track: block.track, timestampNs }
      })
  })
  const duration = container.structure.info.find(({ id }) => id === 0x4489)
  assert.equal(duration.end - duration.data, 8)
  return { seeks, cues, durationNs: bytes.readDoubleBE(duration.data) * container.timestampScaleNs }
}

// Fixture-only EBML regrouping. Keep original BlockGroups and the cluster
// boundary across each audio gap: the current reader overrides even explicit
// BlockDuration with the distance to the next same-track block in a cluster.
export function transformContainer(original, streams, timestampScaleNs, regroup) {
  const { bytes, top, info, segment, children, unsigned, signed, vint } = original.structure
  const raw = (element) => bytes.subarray(element.offset, element.end)
  const integer = (value, width, signedValue = false) => {
    assert.ok(typeof value === 'bigint' || Number.isSafeInteger(value))
    value = BigInt(value)
    if (!signedValue) {
      assert.ok(value >= 0n)
      while (value >= 1n << BigInt(8 * width)) width++
    } else {
      assert.ok(value >= -(1n << BigInt(8 * width - 1)) && value < 1n << BigInt(8 * width - 1))
    }
    let encoded = BigInt.asUintN(width * 8, value)
    const result = Buffer.alloc(width)
    for (let i = width - 1; i >= 0; i--) {
      result[i] = Number(encoded & 255n)
      encoded >>= 8n
    }
    return result
  }
  const size = (length, width) => {
    while (BigInt(length) >= (1n << BigInt(7 * width)) - 1n) width++
    return integer((1n << BigInt(7 * width)) | BigInt(length), width)
  }
  const element = (idBytes, payload, width = 1) =>
    Buffer.concat([idBytes, size(payload.length, width), payload])
  const rebuild = (entry, payload) => {
    const idLength = vint(entry.offset, true).length
    return element(
      bytes.subarray(entry.offset, entry.offset + idLength),
      payload,
      entry.data - entry.offset - idLength
    )
  }
  const valueElement = (entry, value) => rebuild(entry, integer(value, entry.end - entry.data))
  const ticks = (nanoseconds) => {
    const value = nanoseconds / timestampScaleNs
    assert.ok(Number.isSafeInteger(value), 'A timestamp cannot be represented exactly at the candidate scale')
    return value
  }
  const packetTiming = new Map()
  original.blocks.forEach((blocks, index) =>
    blocks.forEach((block, position) =>
      packetTiming.set(block.element.offset, {
        durationNs: ns(streams[index].packets[position].duration),
        previousTimestampNs: blocks[position - 1]?.timestampNs
      })
    )
  )
  const rewriteBlock = (block, clusterTimestampNs, lastOfTrack) => {
    const result = Buffer.from(raw(block.element))
    const offset = block.payloadElement.data - block.element.offset
    const relative = ticks(block.timestampNs - clusterTimestampNs)
    assert.ok(relative >= -32768 && relative <= 32767)
    result.writeInt16BE(relative, offset + vint(block.payloadElement.data).length)
    for (const field of block.group ?? []) {
      if (![0x9b, 0xfb].includes(field.id)) continue
      const value = field.id === 0xfb ? signed(field) : unsigned(field)
      integer(ticks(value * original.timestampScaleNs), field.end - field.data, field.id === 0xfb).copy(
        result,
        field.data - block.element.offset
      )
    }
    if (lastOfTrack && block.element.id === 0xa3) {
      // A newly created cluster boundary needs an explicit final duration.
      // Preserve its compressed Block and mark a delta's existing dependency.
      const payload = Buffer.from(result.subarray(block.payloadElement.data - block.element.offset))
      payload[vint(block.payloadElement.data).length + 2] &= 0x7e
      const timing = packetTiming.get(block.element.offset)
      const reference = block.key
        ? []
        : [
            element(
              Buffer.from([0xfb]),
              integer(ticks(timing.previousTimestampNs - block.timestampNs), 2, true)
            )
          ]
      return element(
        Buffer.from([0xa0]),
        Buffer.concat([
          element(Buffer.from([0xa1]), payload),
          ...reference,
          element(Buffer.from([0x9b]), integer(ticks(timing.durationNs), 1))
        ])
      )
    }
    return result
  }
  const keyTimes = original.blocks[0].filter(({ key }) => key).map(({ timestampNs }) => timestampNs)
  assert.deepEqual(keyTimes, [0, 2_000_000_000])
  const gapBoundaries = streams.flatMap(({ packets }, trackIndex) =>
    packets.slice(1).flatMap((packet, position) => {
      const previous = packets[position]
      if (ns(packet.timestamp - previous.timestamp - previous.duration) <= 0) return []
      const nextBlock = original.blocks[trackIndex][position + 1]
      const cluster = original.clusters.find(({ blocks }) => blocks.includes(nextBlock))
      assert.ok(
        cluster.timestampNs > original.blocks[trackIndex][position].timestampNs,
        'The original gap must cross a cluster boundary'
      )
      return [cluster.timestampNs]
    })
  )
  const regroupTimes = [...new Set([...keyTimes, ...gapBoundaries])].sort((a, b) => a - b)
  assert.deepEqual(regroupTimes, [0, 1_360_000_000, 2_000_000_000])
  const groups = regroup
    ? regroupTimes.map((timestampNs) => ({ timestampNs, blocks: [] }))
    : original.clusters.map(({ timestampNs, blocks }) => ({ timestampNs, blocks }))
  if (regroup) {
    for (const block of original.clusters.flatMap(({ blocks }) => blocks)) {
      const index = regroupTimes.findLastIndex((time) => time <= block.timestampNs)
      assert.ok(index >= 0)
      groups[index].blocks.push(block)
    }
  }
  const locations = new Map()
  const newClusters = groups.map(({ timestampNs, blocks }, groupIndex) => {
    const timestamp = element(Buffer.from([0xe7]), integer(ticks(timestampNs), 1))
    const payload = [timestamp]
    let relativePosition = timestamp.length
    const last = new Map(blocks.map((block) => [block.track, block.element.offset]))
    for (const block of blocks) {
      const rewritten = rewriteBlock(block, timestampNs, last.get(block.track) === block.element.offset)
      locations.set(block.element.offset, { groupIndex, relativePosition, track: block.track })
      relativePosition += rewritten.length
      payload.push(rewritten)
    }
    return { id: 0x1f43b675, data: rebuild(original.clusters[0].element, Buffer.concat(payload)), groupIndex }
  })
  const nextInfo = rebuild(
    top.find(({ id }) => id === 0x1549a966),
    Buffer.concat(
      info.map((entry) => {
        if (entry.id === 0x2ad7b1) return valueElement(entry, timestampScaleNs)
        if (entry.id === 0x4489) {
          assert.equal(entry.end - entry.data, 8)
          const value = Buffer.from(bytes.subarray(entry.data, entry.end))
          value.writeDoubleBE((value.readDoubleBE() * original.timestampScaleNs) / timestampScaleNs)
          return rebuild(entry, value)
        }
        return raw(entry)
      })
    )
  )
  const firstCluster = top.findIndex(({ id }) => id === 0x1f43b675)
  const lastCluster = top.findLastIndex(({ id }) => id === 0x1f43b675)
  assert.ok(top.slice(firstCluster, lastCluster + 1).every(({ id }) => id === 0x1f43b675))
  assert.ok(top.findIndex(({ id }) => id === 0x1c53bb6b) > lastCluster, 'Expected cues after clusters')
  const pieces = top.flatMap((entry, index) =>
    entry.id === 0x1f43b675
      ? index === firstCluster
        ? newClusters
        : []
      : [{ id: entry.id, data: entry.id === 0x1549a966 ? nextInfo : raw(entry), original: entry }]
  )
  const offsets = new Map(),
    clusterOffsets = []
  let position = 0
  for (const piece of pieces) {
    offsets.set(piece.id, position)
    if (piece.groupIndex !== undefined) clusterOffsets[piece.groupIndex] = position
    position += piece.data.length
  }
  const oldClusters = new Map(original.clusters.map(({ element }) => [element.offset, element]))
  const cues = pieces.find(({ id }) => id === 0x1c53bb6b)
  cues.data = rebuild(
    cues.original,
    Buffer.concat(
      children(cues.original).map((point) =>
        rebuild(
          point,
          Buffer.concat(
            children(point).map((field) => {
              if (field.id === 0xb3)
                return valueElement(field, ticks(unsigned(field) * original.timestampScaleNs))
              assert.equal(field.id, 0xb7)
              const fields = children(field)
              const cluster = oldClusters.get(unsigned(fields.find(({ id }) => id === 0xf1)) + segment.data)
              assert.ok(cluster)
              const located = locations.get(cluster.data + unsigned(fields.find(({ id }) => id === 0xf0)))
              assert.ok(located)
              assert.equal(located.track, unsigned(fields.find(({ id }) => id === 0xf7)))
              return rebuild(
                field,
                Buffer.concat(
                  fields.map((entry) => {
                    if (entry.id === 0xf1) return valueElement(entry, clusterOffsets[located.groupIndex])
                    if (entry.id === 0xf0) return valueElement(entry, located.relativePosition)
                    assert.equal(entry.id, 0xf7)
                    return raw(entry)
                  })
                )
              )
            })
          )
        )
      )
    )
  )
  const seekHead = pieces.find(({ id }) => id === 0x114d9b74)
  const oldSeekLength = seekHead.data.length
  seekHead.data = rebuild(
    seekHead.original,
    Buffer.concat(
      children(seekHead.original).map((seek) => {
        const fields = children(seek)
        const target = unsigned(fields.find(({ id }) => id === 0x53ab))
        assert.ok(offsets.has(target))
        return rebuild(
          seek,
          Buffer.concat(
            fields.map((entry) =>
              entry.id === 0x53ac ? valueElement(entry, offsets.get(target)) : raw(entry)
            )
          )
        )
      })
    )
  )
  assert.equal(seekHead.data.length, oldSeekLength, 'SeekHead offset widths must remain stable')
  assert.equal(segment.end, bytes.length)
  return Buffer.concat([
    bytes.subarray(0, segment.offset),
    rebuild(segment, Buffer.concat(pieces.map(({ data }) => data)))
  ])
}

function compareContainers(original, candidate, streams) {
  assert.deepEqual(
    validateContainerIndex(candidate),
    validateContainerIndex(original),
    'Index targets or container duration changed'
  )
  assert.deepEqual(candidate.tracks, original.tracks, 'Track configuration bytes changed')
  assert.deepEqual(candidate.trackTiming, original.trackTiming, 'CodecDelay or SeekPreRoll changed')
  assert.equal(candidate.blocks.length, original.blocks.length)
  const content = ({ element, payloadElement, group, durationNs, referencesNs, ...packet }) => packet
  assert.deepEqual(
    candidate.clusters.flatMap(({ blocks }) => blocks.map(content)),
    original.clusters.flatMap(({ blocks }) => blocks.map(content)),
    'Interleaved packet order changed'
  )
  for (const [index, blocks] of original.blocks.entries()) {
    assert.deepEqual(
      candidate.blocks[index].map(content),
      blocks.map(content),
      `Raw track ${index + 1} packets/timestamps/discard changed`
    )
    for (const [position, block] of blocks.entries()) {
      const after = candidate.blocks[index][position]
      if (block.durationNs !== null) assert.equal(after.durationNs, block.durationNs)
      else if (after.durationNs !== null)
        assert.equal(after.durationNs, ns(streams[index].packets[position].duration))
      if (block.referencesNs.length) assert.deepEqual(after.referencesNs, block.referencesNs)
      else if (after.referencesNs.length) {
        assert.equal(block.key, false)
        assert.deepEqual(after.referencesNs, [blocks[position - 1].timestampNs - block.timestampNs])
      }
    }
  }
}

const layout = (container) => ({
  timestampScaleNs: container.timestampScaleNs,
  clusters: container.clusters.map(({ timestampNs, blocks }) => ({
    timestampNs,
    blocks: blocks.length,
    firstTrack: blocks[0]?.track,
    startsWithVideoRAP: blocks[0]?.track === 1 && blocks[0]?.key,
    firstVideoKey: blocks.find(({ track }) => track === 1)?.key ?? null
  }))
})

export async function prepareShortAudioLayout(destination, source = fixture) {
  const output = path.resolve(destination)
  const bytes = await readFile(source)
  const original = inspectContainer(bytes)
  assert.equal(original.timestampScaleNs, 10_000)
  const input = inputFor(bytes)
  try {
    const streams = await readPackets(input)
    assert.deepEqual(
      streams.map(({ packets }) => packets.length),
      [28, 137, 89]
    )
    const packetReports = []
    for (const [index, { track, packets }] of streams.entries()) {
      const gaps = packets.slice(1).flatMap((packet, position) => {
        const previous = packets[position]
        const durationNs = ns(packet.timestamp - previous.timestamp - previous.duration)
        return durationNs ? [{ beforePacket: position + 1, durationNs }] : []
      })
      packetReports.push({
        type: track.type,
        codec: await track.getCodec(),
        packets: packets.length,
        firstTimestampNs: ns(packets[0].timestamp),
        lastTimestampNs: ns(packets.at(-1).timestamp),
        durationNs: [...new Set(packets.map(({ duration }) => ns(duration)))],
        gaps,
        primingNs: original.trackTiming[index].codecDelayNs,
        finalDiscardPaddingNs: original.blocks[index].at(-1).discardPaddingNs
      })
    }
    const candidates = {},
      candidateData = new Map()
    for (const [name, regroup] of [
      ['reticked', false],
      ['regrouped', true]
    ]) {
      const data = transformContainer(original, streams, 100_000, regroup)
      const candidate = inspectContainer(data)
      assert.equal(candidate.timestampScaleNs, 100_000)
      compareContainers(original, candidate, streams)
      const reopened = inputFor(data)
      try {
        assert.deepEqual(await reopened.getMetadataTags(), await input.getMetadataTags())
        const next = await readPackets(reopened)
        assert.equal(next.length, streams.length)
        for (const [index, { packets, decoderConfig }] of streams.entries()) {
          assert.deepEqual(next[index].decoderConfig, decoderConfig, 'Decoder configuration changed')
          assert.equal(next[index].packets.length, packets.length)
          for (const [position, before] of packets.entries()) {
            const after = next[index].packets[position]
            const label = `${name} track ${index + 1} packet ${position}`
            assert.deepEqual(after.data, before.data, label + ' compressed bytes')
            assert.deepEqual(
              [ns(after.timestamp), ns(after.duration), after.type, after.sideData],
              [ns(before.timestamp), ns(before.duration), before.type, before.sideData],
              label + ' timing/type/side data'
            )
          }
        }
      } finally {
        reopened.dispose()
      }
      candidates[name] = {
        path: path.join(output, `${name}-100000ns.webm`),
        bytes: data.length,
        ...layout(candidate)
      }
      candidateData.set(candidates[name].path, data)
    }
    const report = {
      verified: true,
      original: {
        path: path.join(output, 'original-10000ns.webm'),
        bytes: bytes.length,
        ...layout(original)
      },
      ...candidates,
      preservation: {
        originalBytesCopied: true,
        trackConfigurationBytesEqual: true,
        compressedPacketsAndOrderEqual: true,
        timestampsDurationsAndTypesEqual: true,
        primingDiscardAndGapsEqual: true,
        metadataEqual: true,
        existingExplicitDurationsAndReferencesPreserved: true,
        seekAndCueTargetsResolvedAndEquivalent: true,
        containerDurationEqual: true
      },
      tracks: packetReports,
      scope:
        'Unadopted fixture-only experiment: scale-only retick preserves nine original clusters; gap-preserving regroup uses existing video RAPs plus the original 1.36 s cluster boundary across the stereo gap. Original BlockGroups are retained; newly final blocks receive their unchanged explicit duration. No decoding, encoding, product fallback, or assertion changes',
      readerLimitation:
        'The current MediaBunny reader replaces explicit BlockDuration with the next same-track timestamp distance within a cluster. RAP-only regroup at 0/2 s therefore changes its reported pre-gap stereo packet duration from 20 ms to 220 ms even when the original explicit 20 ms BlockDuration is retained. Keeping the original 1.36 s boundary preserves current packet semantics; the reader is not changed.'
    }
    await mkdir(output, { recursive: true })
    await writeFile(report.original.path, bytes)
    for (const [file, data] of candidateData) await writeFile(file, data)
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    return report
  } finally {
    input.dispose()
  }
}

if (import.meta.main) {
  const report = await prepareShortAudioLayout(process.argv[2] ?? 'build/short-audio-layout', process.argv[3])
  console.log(JSON.stringify(report))
}
