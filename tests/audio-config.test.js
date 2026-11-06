import assert from 'node:assert/strict'
import test from 'node:test'
import { aacDecoderCookie, aacDescriptionFromCookie } from '../web/audio-config.js'

const stereo48 = { sampleRate: 48000, channels: 2 }
const stereo44 = { sampleRate: 44100, channels: 2 }
const mono48 = { sampleRate: 48000, channels: 1 }
const hex = (value) => Uint8Array.from(Buffer.from(value.replaceAll(/\s/g, ''), 'hex'))
const compactCookie = hex('03 16 000100 04 11 4015 000000 00000000 00000000 05 02 1190')
// Synthetic 39-byte shape using fixed-width descriptor lengths and an MP4 SLConfig sibling.
const longCookie = hex(
  '03 80808022 000100 04 80808014 4015 000000 00000000 00000000 05 80808002 1190 06 80808001 02'
)

test('extracts the exact AAC-LC descriptions from captured arm64 AudioToolbox cookies', () => {
  // Generated fixture output from OpenLR Actions run 42162931607, job 127712629776.
  for (const [cookie, format, description] of [
    ['038080802200000004808080144014001800000000000000fa0005808080021188068080800102', mono48, '1188'],
    ['038080802200000004808080144014001800000000000001f40005808080021190068080800102', stereo48, '1190'],
    ['038080802200000004808080144014001800000000000001f40005808080021210068080800102', stereo44, '1210']
  ]) {
    assert.deepEqual(aacDescriptionFromCookie(hex(cookie), format), hex(description))
  }
})

test('reads nested AAC descriptions without changing the cookie or aliasing its storage', () => {
  for (const cookie of [compactCookie, longCookie, Buffer.from(longCookie)]) {
    const original = Uint8Array.from(cookie)
    const description = aacDescriptionFromCookie(cookie, stereo48)
    assert.deepEqual(description, hex('1190'))
    description.fill(0)
    assert.deepEqual(Uint8Array.from(cookie), original)
  }
})

test('wraps exactly the incoming AudioSpecificConfig bytes in an AudioToolbox ES descriptor', () => {
  assert.deepEqual(aacDecoderCookie(hex('1190'), stereo48), compactCookie)
  const cases = [
    [hex('1188'), mono48],
    // ffprobe extradata from independently encoded FFmpeg AAC-LC at each rate.
    [hex('119056e500'), stereo48],
    [hex('121056e500'), stereo44],
    [hex('17805dc010'), stereo48] // explicit 48000 Hz
  ]
  for (const [description, format] of cases) {
    const original = description.slice()
    const cookie = aacDecoderCookie(description, format)
    description.fill(0)
    assert.deepEqual(aacDescriptionFromCookie(cookie, format), original)
  }
})

test('walks optional elementary-stream fields and multi-byte sibling lengths within their parent', () => {
  const cookie = Uint8Array.from([
    ...hex('03 8121 0001e0 0002 03 75726c 0003'), // ES dependency, URL and OCR stream ID
    ...hex('14 8100'),
    ...new Uint8Array(128).fill(0x05), // DecoderSpecificInfo-shaped decoy inside unrelated sibling data
    ...compactCookie.subarray(5)
  ])
  assert.deepEqual(aacDescriptionFromCookie(cookie, stereo48), hex('1190'))
})

test('rejects truncated, unbounded, misplaced and ambiguous descriptors', () => {
  for (const cookie of [compactCookie, longCookie]) {
    for (let size = 0; size < cookie.length; size++) {
      assert.throws(
        () => aacDescriptionFromCookie(cookie.subarray(0, size), stereo48),
        /AAC cookie/,
        `size ${size}`
      )
    }
  }
  for (const [offset, byte] of [
    [0, 4], // wrong root
    [4, 0x40], // URL bytes exceed root
    [5, 5], // missing DecoderConfigDescriptor
    [6, 0x7f], // config exceeds root
    [7, 0x66], // non-MPEG-4 object type
    [8, 0x11], // non-audio stream type
    [8, 0x17], // upstream stream
    [20, 0x14], // missing DecoderSpecificInfo
    [21, 0x03] // info exceeds config
  ]) {
    const cookie = compactCookie.slice()
    cookie[offset] = byte
    assert.throws(() => aacDescriptionFromCookie(cookie, stereo48), /AAC cookie/, `offset ${offset}`)
  }
  for (const cookie of [
    hex('03 8080808000'),
    hex('11 90'), // ASC alone
    Uint8Array.from([...compactCookie, 0]),
    Uint8Array.from([3, 41, 0, 1, 0, ...compactCookie.subarray(5), ...compactCookie.subarray(5)]),
    hex('03 1a 000100 04 15 4015 000000 00000000 00000000 05 02 1190 05 02 1190'),
    hex('03 16 000100 04 0d 4015 000000 00000000 00000000 05 02 1190') // sibling is not nested
  ]) {
    assert.throws(() => aacDescriptionFromCookie(cookie, stereo48), /AAC cookie/)
  }
})

test('requires matching AAC-LC rate and channels without changing codec tools or frame length', () => {
  for (const [description, format] of [
    [hex('1190'), stereo44],
    [hex('1190'), mono48],
    [hex('1180'), stereo48], // Program Config Element
    [hex('11b0'), { sampleRate: 48000, channels: 6 }],
    [hex('1690'), stereo48], // reserved rate index
    [hex('1780000010'), stereo48], // invalid explicit rate
    [hex('0990'), stereo48], // AAC Main
    [hex('2990'), stereo48], // HE-AAC
    [hex('1194'), stereo48], // 960 frames
    [hex('1192'), stereo48], // dependent core coder
    [hex('1191'), stereo48], // GASpecificConfig extension
    [hex('119056e580'), stereo48], // SBR present in sync extension
    [hex('119056e5'), stereo48], // truncated sync extension
    [hex('1190ff'), stereo48], // unknown tail
    [hex('11'), stereo48] // truncated base
  ]) {
    assert.throws(
      () => aacDecoderCookie(description, format),
      /AAC AudioSpecificConfig|Native AAC/,
      Buffer.from(description).toString('hex')
    )
  }
  assert.throws(() => aacDescriptionFromCookie(compactCookie, stereo44), /does not match/)
})
