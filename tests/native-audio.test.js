import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { chromium } from 'playwright-core'

const rate = 48000
const channels = 2
const opusInfo = {
  sampleRate: rate,
  channels,
  framesPerPacket: 960,
  cookie: '',
  prime: { leading: 312, trailing: 0 }
}
const aacInfo = { sampleRate: rate, channels, framesPerPacket: 1024, cookie: '', prime: null }
const status = (fields) => ({
  data: '',
  packets: [],
  frames: 0,
  consumedFrames: 0,
  needInput: false,
  done: false,
  ...fields
})
const handle = (id, info) => ({ id, info })
const packet = (byte, fields) =>
  status({
    data: Buffer.from([byte]).toString('base64'),
    packets: [{ offset: 0, size: 1, frames: 960 }],
    frames: 960,
    ...fields
  })
const pcm = (samples, fields) => {
  const bytes = Buffer.alloc(samples.length * 4)
  samples.forEach((sample, i) => bytes.writeFloatLE(sample, i * 4))
  return status({ data: bytes.toString('base64'), frames: samples.length / channels, ...fields })
}

test('browser native audio transport with an injected codec bridge', async (t) => {
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const origin = 'https://openlr.test'
  const modules = new Map(
    await Promise.all(
      ['native-audio.js', 'audio-config.js'].map(async (file) => [
        '/' + file,
        await readFile(new URL('../web/' + file, import.meta.url))
      ])
    )
  )
  async function pageFor(test, host) {
    const page = await browser.newPage()
    test.after(() => page.close())
    await page.route(origin + '/*', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' })
      const body = modules.get(path)
      return body ? route.fulfill({ contentType: 'text/javascript', body }) : route.abort()
    })
    await page.exposeFunction('audioFixture', host)
    await page.goto(origin)
    return page
  }

  await t.test(
    'streams bounded little-endian PCM, drains packet output and returns final metadata',
    async (t) => {
      const calls = []
      let process = 0
      let info = 0
      const page = await pageFor(t, (method, id, chunk) => {
        calls.push(method)
        if (method === 'NativeAudio.Open') {
          assert.deepEqual(id, {
            codec: 'opus',
            decode: false,
            sampleRate: rate,
            channels,
            framesPerPacket: 0,
            cookie: ''
          })
          return handle('encoder', opusInfo)
        }
        assert.equal(id, 'encoder')
        if (method === 'NativeAudio.Info') {
          return ++info === 1
            ? { ...opusInfo, cookie: 'AQI=' }
            : { ...opusInfo, cookie: 'AwQ=', prime: { leading: 312, trailing: 17 } }
        }
        if (method === 'NativeAudio.Close') return null
        assert.equal(method, 'NativeAudio.Process')
        assert.deepEqual(chunk.packets, [])
        const bytes = Buffer.from(chunk.data, 'base64')
        switch (++process) {
          case 1:
            assert.equal(bytes.length, 65536)
            assert.equal(bytes.readFloatLE(0), -0.25)
            assert.equal(bytes.readFloatLE(4), 0.75)
            assert.equal(bytes.readFloatLE(65532), -0.5)
            return status({ consumedFrames: 4000 })
          case 2:
            assert.equal(bytes.length, 0)
            return packet(9, { consumedFrames: 4192 })
          case 3:
            assert.equal(bytes.length, 0)
            return packet(10, { needInput: true })
          case 4:
            assert.equal(bytes.length, 8)
            assert.equal(bytes.readFloatLE(0), -0.75)
            assert.equal(bytes.readFloatLE(4), 0.5)
            return status({ consumedFrames: 1, needInput: true })
          case 5:
            assert.deepEqual(chunk, { data: '', packets: [], final: true })
            return packet(11)
          case 6:
            assert.deepEqual(chunk, { data: '', packets: [], final: false })
            return status({ done: true })
          default:
            assert.fail('Unexpected native pull')
        }
      })
      const actual = await page.evaluate(async () => {
        const { encodeNativeAudio } = await import('/native-audio.js')
        globalThis.mygo = { call: globalThis.audioFixture }
        const backing = new Float32Array(16388)
        const input = backing.subarray(2)
        input.set([-0.25, 0.75])
        input.set([-0.5, -0.75, 0.5], input.length - 3)
        const events = []
        const stream = encodeNativeAudio([input], {
          codec: 'opus',
          sampleRate: 48000,
          channels: 2,
          onInfo(info) {
            events.push(['info', Array.from(info.cookie), info.prime])
            info.cookie.fill(0)
          }
        })
        let next
        while (!(next = await stream.next()).done) {
          events.push(['packet', Array.from(next.value.data), next.value.frames])
          next.value.data.fill(0)
        }
        return { events, summary: { ...next.value, cookie: Array.from(next.value.cookie) } }
      })
      assert.deepEqual(actual.events, [
        ['info', [1, 2], { leading: 312, trailing: 0 }],
        ['packet', [9], 960],
        ['packet', [10], 960],
        ['packet', [11], 960]
      ])
      assert.deepEqual(actual.summary, {
        sampleRate: rate,
        channels,
        framesPerPacket: 960,
        prime: { leading: 312, trailing: 17 },
        cookie: [3, 4],
        inputFrames: 8193,
        codedFrames: 2880
      })
      assert.deepEqual(calls, [
        'NativeAudio.Open',
        'NativeAudio.Process',
        'NativeAudio.Process',
        'NativeAudio.Info',
        'NativeAudio.Process',
        'NativeAudio.Process',
        'NativeAudio.Process',
        'NativeAudio.Process',
        'NativeAudio.Info',
        'NativeAudio.Close'
      ])
    }
  )

  await t.test(
    'packs AAC across bounded chunks and yields raw PCM independently of coded counts',
    async (t) => {
      let process = 0
      let closes = 0
      const page = await pageFor(t, (method, id, chunk) => {
        if (method === 'NativeAudio.Open') {
          assert.equal(id.codec, 'aac')
          assert.equal(id.decode, true)
          assert.equal(id.framesPerPacket, 1024)
          assert.equal(
            Buffer.from(id.cookie, 'base64').toString('hex'),
            '03190001000414401500000000000000000000000505119056e500'
          )
          return handle('decoder', aacInfo)
        }
        assert.equal(id, 'decoder')
        if (method === 'NativeAudio.Close') return ++closes
        assert.equal(method, 'NativeAudio.Process')
        const bytes = Buffer.from(chunk.data, 'base64')
        switch (++process) {
          case 1:
            assert.equal(bytes.length, 63000)
            assert.equal(bytes[0], 1)
            assert.equal(bytes[31000], 2)
            assert.deepEqual(chunk.packets, [
              { offset: 0, size: 31000, frames: 1024 },
              { offset: 31000, size: 32000, frames: 1024 }
            ])
            return pcm([0.25, -0.5], { consumedFrames: 1024 })
          case 2:
            assert.equal(bytes.length, 0)
            return status({ consumedFrames: 1024, needInput: true })
          case 3:
            assert.equal(bytes.length, 4000)
            assert.equal(bytes[0], 3)
            assert.deepEqual(chunk.packets, [{ offset: 0, size: 4000, frames: 1024 }])
            return status({ consumedFrames: 1024, needInput: true })
          case 4:
            assert.equal(chunk.final, true)
            return pcm([0.75, -0.25, -1, 1])
          case 5:
            assert.equal(chunk.final, false)
            return status({ done: true })
          default:
            assert.fail('Unexpected AAC pull')
        }
      })
      const actual = await page.evaluate(async () => {
        const { decodeNativeAac } = await import('/native-audio.js')
        globalThis.mygo = { call: globalThis.audioFixture }
        const packets = [31000, 32000, 4000].map((size, i) => ({
          data: new Uint8Array(size).fill(i + 1),
          frames: 1024
        }))
        const stream = decodeNativeAac(packets, {
          sampleRate: 48000,
          channels: 2,
          description: Uint8Array.of(0x11, 0x90, 0x56, 0xe5, 0)
        })
        const frames = []
        let next
        while (!(next = await stream.next()).done)
          frames.push([next.value.frames, Array.from(next.value.pcm)])
        return { frames, summary: next.value }
      })
      assert.deepEqual(actual, {
        frames: [
          [1, [0.25, -0.5]],
          [2, [0.75, -0.25, -1, 1]]
        ],
        summary: { codedFrames: 3072, decodedFrames: 3 }
      })
      assert.equal(closes, 1)
    }
  )

  await t.test(
    'owns separate handles and closes a canceled in-flight pull and an early consumer return',
    async (t) => {
      const closed = []
      const active = new Set()
      let count = 0
      const page = await pageFor(t, (method, id) => {
        if (method === 'NativeAudio.Open') {
          const id = 'encoder-' + ++count
          active.add(id)
          return handle(id, opusInfo)
        }
        assert.ok(active.has(id))
        if (method === 'NativeAudio.Close') {
          closed.push(id)
          active.delete(id)
          return null
        }
        assert.equal(method, 'NativeAudio.Process')
        return packet(12, { consumedFrames: 1, needInput: true })
      })
      const actual = await page.evaluate(async () => {
        const { encodeNativeAudio } = await import('/native-audio.js')
        const controller = new AbortController()
        const reason = new DOMException('Export canceled', 'AbortError')
        globalThis.mygo = {
          async call(method, ...args) {
            const result = await globalThis.audioFixture(method, ...args)
            if (method === 'NativeAudio.Process' && args[0] === 'encoder-2') controller.abort(reason)
            return result
          }
        }
        const config = { codec: 'opus', sampleRate: 48000, channels: 2 }
        const first = encodeNativeAudio([Float32Array.of(0, 0)], config)
        const second = encodeNativeAudio([Float32Array.of(0, 0)], { ...config, signal: controller.signal })
        const packet = await first.next()
        let canceled
        try {
          await second.next()
        } catch (error) {
          canceled = error === reason
        }
        globalThis.mygo = {
          call: () => {
            throw Error('Replacement bridge must not receive cleanup')
          }
        }
        const returned = await first.return()
        return { byte: packet.value.data[0], canceled, returned: returned.done }
      })
      assert.deepEqual(actual, { byte: 12, canceled: true, returned: true })
      assert.deepEqual(closed, ['encoder-2', 'encoder-1'])
      assert.equal(active.size, 0)
    }
  )

  await t.test('closes rejected negotiation and reports both operation and cleanup failures', async (t) => {
    const closed = []
    let count = 0
    const page = await pageFor(t, (method, id) => {
      if (method === 'NativeAudio.Open') {
        return ++count === 1
          ? handle('changed-format', { ...opusInfo, channels: 1 })
          : handle('failed', opusInfo)
      }
      if (method === 'NativeAudio.Process') throw Error('Controlled converter failure')
      assert.equal(method, 'NativeAudio.Close')
      closed.push(id)
      if (id === 'failed') throw Error('Controlled disposal failure')
      return null
    })
    const actual = await page.evaluate(async () => {
      const { encodeNativeAudio } = await import('/native-audio.js')
      globalThis.mygo = { call: globalThis.audioFixture }
      const config = { codec: 'opus', sampleRate: 48000, channels: 2 }
      const failures = []
      for (let i = 0; i < 2; i++) {
        try {
          await encodeNativeAudio([Float32Array.of(0, 0)], config).next()
        } catch (error) {
          failures.push({
            message: error.message,
            cause: error.cause?.message,
            errors: error.errors?.map(({ message }) => message)
          })
        }
      }
      return failures
    })
    assert.match(actual[0].message, /changed the sample rate or channel count/)
    assert.match(actual[1].message, /Controlled converter failure.*Controlled disposal failure/)
    assert.match(actual[1].cause, /encoder process failed: Controlled converter failure/)
    assert.match(actual[1].errors[1], /encoder close failed: Controlled disposal failure/)
    assert.deepEqual(closed, ['changed-format', 'failed'])
  })
})
