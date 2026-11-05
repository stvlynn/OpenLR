import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPng } from '../../web/png.js'
import { convertPngPixels } from '../../web/png-color.js'
import { makePng } from '../../tests/fixtures/png.mjs'
import { iccCurve, makeGrayProfile } from '../../tests/fixtures/icc-input.mjs'

export function runPngColorExperiment() {
  const srgbChromaticities = {
      white: [0.3127, 0.329],
      red: [0.64, 0.33],
      green: [0.3, 0.6],
      blue: [0.15, 0.06]
    },
    spaces = {
      srgb: srgbChromaticities,
      p3: { ...srgbChromaticities, red: [0.68, 0.32], green: [0.265, 0.69] },
      'd50-wide': {
        white: [0.34567, 0.3585],
        red: [0.7347, 0.2653],
        green: [0.1596, 0.8404],
        blue: [0.0366, 0.0001]
      }
    },
    input = []
  for (let r = 0; r < 17; r++)
    for (let g = 0; g < 17; g++)
      for (let b = 0; b < 17; b++) input.push([r, g, b].map((v) => Math.round((v * 65535) / 16)))
  for (let value = 0; value < 513; value++) input.push([value, value, value])
  const cases = []
  function add(name, colors, options) {
    const words = colors.flatMap((color, i) => [...color, (i * 149) % 65536]),
      png = makePng({
        width: colors.length,
        height: 1,
        bits: 16,
        colorType: options.profile ? 4 : 6,
        data: words,
        filter: 4,
        ...options
      }),
      decoded = readPng(png),
      source = decoded.data.slice(),
      result = convertPngPixels(decoded)
    if (!result.frame) throw Error(name + ': ' + result.reason)
    cases.push({
      name,
      png: Array.from(png),
      words,
      gamma: options.gamma,
      chromaticities: options.chromaticities,
      profile: options.profile ? Array.from(options.profile) : undefined,
      input: Array.from({ length: colors.length }, (_, i) => Array.from(source.subarray(i * 4, i * 4 + 3))),
      expected: Array.from({ length: colors.length }, (_, i) =>
        Array.from(result.frame.data.subarray(i * 4, i * 4 + 3))
      )
    })
  }
  for (const [name, chromaticities] of Object.entries(spaces))
    for (const gamma of [1, 0.45455, 0.55556]) add(`${name}-${gamma}`, input, { gamma, chromaticities })
  const gray = Array.from({ length: 4096 }, (_, i) => [Math.round((i * 65535) / 4095)])
  add('gray-gamma', gray, { profile: makeGrayProfile(iccCurve(0, [2.2])) })
  add('gray-table', gray, { profile: makeGrayProfile(iccCurve('curv', [0, 1000, 14000, 40000, 65535])) })
  return spawnSync(
    process.env.OPENLR_CMS_PYTHON || 'python',
    [fileURLToPath(new URL('./png-input-color.py', import.meta.url))],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      input: JSON.stringify({ srgbChromaticities, cases }),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    }
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runPngColorExperiment()
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) process.stderr.write(String(result.error))
  process.exitCode = result.status ?? 1
}
