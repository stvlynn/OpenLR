// Independently generated numeric TIFF experiment. No external image assets.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import UTIF from '../../web/vendor/codecs/utif.js'
import { makeTiffFixture } from '../../tests/fixtures/tiff.mjs'

const results = []
function run(options) {
  const { bytes, samples } = makeTiffFixture(options),
    original = bytes.slice()
  const image = UTIF.decode(bytes.buffer)[0]
  UTIF.decodeImage(bytes.buffer, image)
  const view = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  const actual = samples.map((_, i) => (options.bits === 16 ? view.getUint16(i * 2, true) : view.getUint8(i)))
  assert.deepEqual(bytes, original)
  results.push({
    ...options,
    exact: actual.every((value, i) => value === samples[i]),
    samples: samples.length
  })
}
for (const bits of [8, 16])
  for (const littleEndian of [true, false])
    for (const compression of [1, 5, 8, 32773])
      for (const predictor of [1, 2]) {
        for (const [photo, channels] of [
          [2, 3],
          [2, 4],
          [0, 1],
          [1, 1],
          [1, 2]
        ])
          run({
            bits,
            littleEndian,
            compression,
            predictor,
            photo,
            channels,
            alpha: channels === 4 || channels === 2 ? 2 : 0
          })
        for (const [width, height] of [
          [17, 18],
          [5, 4],
          [32, 32],
          [33, 2]
        ])
          for (const [photo, channels, alpha] of [
            [2, 3, 0],
            [2, 4, 1],
            [2, 4, 2],
            [0, 1, 0],
            [1, 1, 0],
            [1, 2, 1],
            [1, 2, 2]
          ])
            run({
              bits,
              littleEndian,
              compression,
              predictor,
              photo,
              channels,
              alpha,
              tileSize: 16,
              width,
              height
            })
      }
await mkdir('.workspace/tiff-precision', { recursive: true })
await writeFile('.workspace/tiff-precision/production-results.json', JSON.stringify(results, null, 2) + '\n')
const summary = { cases: results.length, exact: results.filter((result) => result.exact).length }
console.log(JSON.stringify(summary))
assert.equal(summary.exact, summary.cases)
