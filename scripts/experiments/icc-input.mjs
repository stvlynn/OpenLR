import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makeColorProfile, matrixToLinearSrgb } from '../../web/color-spaces.js'
import { createProfileToLinearSrgb } from '../../web/icc-input.js'
import { iccCurve, withIccCurve } from '../../tests/fixtures/icc-input.mjs'

/** Optional independent native LCMS validation. Exit 77 denotes missing tooling;
 * explicit library/Python configuration failures remain visible to the caller.
 */
export function runIccInputExperiment() {
  const profiles = Object.fromEntries(
      ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020'].map((id) => [id, makeColorProfile(id)])
    ),
    curves = {
      identity: iccCurve('curv'),
      gamma: iccCurve('curv', [563]),
      table: iccCurve('curv', [0, 1000, 14000, 40000, 65535]),
      para0: iccCurve(0, [2.2]),
      para1: iccCurve(1, [2.2, 1.1, -0.1]),
      para2: iccCurve(2, [2.2, 1.1, -0.1, 0.01]),
      para3: iccCurve(3, [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045]),
      para4: iccCurve(4, [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045, 0.01, 0.01])
    }
  for (const [name, curve] of Object.entries(curves))
    for (const major of name.startsWith('para') ? [4] : [2, 4])
      profiles[`${name}-v${major}`] = withIccCurve(curve, { major })
  const colors = []
  for (let r = 0; r < 17; r++)
    for (let g = 0; g < 17; g++) for (let b = 0; b < 17; b++) colors.push([r / 16, g / 16, b / 16])
  for (let i = 0; i < 4096; i++) colors.push([i / 4095, i / 4095, i / 4095])
  for (let i = 0; i < 513; i++) colors.push([i / 65535, 0, 0], [0, i / 65535, 0], [0, 0, i / 65535])
  for (const boundary of [1 / 32, 0.04045, 0.1 / 1.1])
    for (const delta of [-1e-7, 0, 1e-7]) colors.push(Array(3).fill(boundary + delta))
  const input = colors.map((color) => color.map(Math.fround)),
    expected = {}
  for (const [name, profile] of Object.entries(profiles)) {
    const transform = createProfileToLinearSrgb(profile)
    if (!transform.convert) throw Error(`Unexpected unsupported fixture: ${name}, ${transform.reason}`)
    expected[name] = input.map((color) => Array.from(transform.convert(...color, new Float32Array(3))))
  }
  return spawnSync(
    process.env.OPENLR_CMS_PYTHON || 'python',
    [fileURLToPath(new URL('./icc-input.py', import.meta.url))],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      input: JSON.stringify({
        profiles: Object.fromEntries(
          Object.entries(profiles).map(([name, profile]) => [name, Array.from(profile)])
        ),
        colors: input,
        expected,
        xyzToLinearSrgb: matrixToLinearSrgb([1, 0, 0, 0, 1, 0, 0, 0, 1])
      }),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    }
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runIccInputExperiment()
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) process.stderr.write(String(result.error))
  process.exitCode = result.status ?? 1
}
