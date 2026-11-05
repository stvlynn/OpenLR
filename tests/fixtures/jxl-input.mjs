// Original deterministic sample definitions for the small encoded fixtures in jxl/.
// scripts/experiments/jxl-input-color.mjs reproduces the actual codestreams with
// the separate validation-only public libjxl encoder. No photograph is used.
import { makeColorProfile } from '../../web/color-spaces.js'
import { iccCurve, makeGrayProfile, rebuildIcc, withIccCurve } from './icc-input.mjs'

export function jxlInputCases() {
  const rgba = (width, height, pixel, Type = Uint16Array) =>
      Type.from(
        Array.from({ length: width * height }, (_, i) => pixel(i % width, Math.floor(i / width), i)).flat()
      ),
    srgb = makeColorProfile(),
    p3 = makeColorProfile('display-p3'),
    linear = withIccCurve(iccCurve('curv')),
    base = {
      bits: 16,
      exponentBits: 0,
      usesOriginalProfile: true,
      orientation: 1,
      premultiplied: false,
      structuredTransfer: -1,
      numColorChannels: 3
    },
    cases = {}
  const add = (name, width, height, data, profile, extra = {}) => {
    cases[name] = { ...base, name, width, height, data, profile, ...extra }
  }
  add(
    'srgb16',
    512,
    16,
    rgba(512, 16, (x) => [1000 + x, 2000 + x, 3000 + x, 65535]),
    srgb
  )
  add(
    'p3-16',
    512,
    4,
    rgba(512, 4, (x, y) =>
      x < 4
        ? [
            [65535, 0, 0, 65535],
            [0, 65535, 0, 65535],
            [0, 0, 65535, 65535],
            [32768, 32768, 32768, 65535]
          ][x]
        : [(x * 149 + y * 257) % 65536, (x * 313 + 1) % 65536, (x * 577 + 3) % 65536, 65535]
    ),
    p3
  )
  add(
    'gray16',
    512,
    2,
    rgba(512, 2, (x) => [1000 + x, 65535]),
    makeGrayProfile(iccCurve('curv', [563])),
    { numColorChannels: 1 }
  )
  const floatPattern = (x, y, i) =>
    x === 0 ? [-0.125, 0.5, 1.5, 1] : [0.1 + i / 1048576, 0.3 + i / 65536, 0.7 + i / 32768, 1]
  add('linear-float', 32, 16, rgba(32, 16, floatPattern, Float32Array), linear, {
    bits: 32,
    exponentBits: 8,
    structuredTransfer: 8
  })
  add('p3-float', 32, 16, rgba(32, 16, floatPattern, Float32Array), p3, { bits: 32, exponentBits: 8 })
  add('xyb-float', 32, 16, rgba(32, 16, floatPattern, Float32Array), linear, {
    bits: 32,
    exponentBits: 8,
    usesOriginalProfile: false,
    structuredTransfer: 8
  })
  for (const [name, structuredTransfer] of [
    ['pq16', 16],
    ['hlg16', 18]
  ])
    add(
      name,
      128,
      2,
      rgba(128, 2, (x) => [
        Math.round((x * 65535) / 127),
        Math.round((x * 65535) / 127),
        Math.round((x * 65535) / 127),
        65535
      ]),
      srgb,
      { structuredTransfer }
    )
  const lut = new Uint8Array(68),
    view = new DataView(lut.buffer)
  lut.set(new TextEncoder().encode('mAB '))
  lut[8] = lut[9] = 3
  view.setUint32(12, 32)
  for (let i = 0; i < 3; i++) lut.set(iccCurve('curv'), 32 + i * 12)
  const lutSamples = rgba(32, 16, (x, y) => [3000 + x * 1000, 5000 + y * 1500, 12000 + x * 600, 65535])
  add('lut-b-only16', 32, 16, lutSamples, rebuildIcc({ A2B0: lut }))
  const matrixLut = new Uint8Array(152),
    matrixView = new DataView(matrixLut.buffer)
  matrixLut.set(lut)
  matrixView.setUint32(16, 68)
  matrixView.setUint32(20, 116)
  for (let i = 0; i < 3; i++) {
    matrixView.setInt32(68 + i * 16, 65536)
    matrixLut.set(iccCurve('curv'), 116 + i * 12)
  }
  add('lut16', 32, 16, lutSamples, rebuildIcc({ A2B0: matrixLut }))
  const nonlinear = iccCurve('curv', [512]),
    nonlinearB = new Uint8Array(80),
    nonlinearView = new DataView(nonlinearB.buffer)
  nonlinearB.set(lut.subarray(0, 32))
  for (let i = 0; i < 3; i++) nonlinearB.set(nonlinear, 32 + i * 16)
  add('lut-b-gamma16', 32, 16, lutSamples, rebuildIcc({ A2B0: nonlinearB }))
  const nonlinearMatrix = new Uint8Array(164),
    nonlinearMatrixView = new DataView(nonlinearMatrix.buffer)
  nonlinearMatrix.set(nonlinearB)
  nonlinearMatrixView.setUint32(16, 80)
  nonlinearMatrixView.setUint32(20, 128)
  for (let i = 0; i < 3; i++) {
    nonlinearMatrixView.setInt32(80 + i * 16, 65536)
    nonlinearMatrix.set(iccCurve('curv'), 128 + i * 12)
  }
  add('lut-matrix-gamma16', 32, 16, lutSamples, rebuildIcc({ A2B0: nonlinearMatrix }))
  add('lut-a2b1-16', 32, 16, lutSamples, rebuildIcc({ A2B1: matrixLut }), { cmsIntent: 1 })
  add('lut-priority16', 32, 16, lutSamples, rebuildIcc({ A2B0: matrixLut, A2B1: nonlinearMatrix }))
  for (const bytesPerEntry of [1, 2]) {
    const entries = bytesPerEntry === 1 ? 256 : 2,
      start = bytesPerEntry === 1 ? 48 : 52,
      payload = new Uint8Array(start + (entries * 6 + 8 * 3) * bytesPerEntry),
      tableView = new DataView(payload.buffer)
    payload.set(new TextEncoder().encode(bytesPerEntry === 1 ? 'mft1' : 'mft2'))
    payload[8] = payload[9] = 3
    payload[10] = 2
    for (let i = 0; i < 3; i++) tableView.setInt32(12 + i * 16, 65536)
    if (bytesPerEntry === 2) {
      tableView.setUint16(48, entries)
      tableView.setUint16(50, entries)
    }
    let at = start
    const put = (value) => {
      if (bytesPerEntry === 1) payload[at++] = value
      else {
        tableView.setUint16(at, value)
        at += 2
      }
    }
    const maximum = bytesPerEntry === 1 ? 255 : 65535
    for (let c = 0; c < 3; c++)
      for (let i = 0; i < entries; i++) put(Math.round((i * maximum) / (entries - 1)))
    for (let r = 0; r < 2; r++)
      for (let g = 0; g < 2; g++)
        for (let b = 0; b < 2; b++) for (const value of [r, g, b]) put(value * maximum)
    for (let c = 0; c < 3; c++)
      for (let i = 0; i < entries; i++) put(Math.round((i * maximum) / (entries - 1)))
    add(`lut-mft${bytesPerEntry}-16`, 32, 16, lutSamples, rebuildIcc({ A2B0: payload }))
  }
  add(
    'table-float',
    32,
    1,
    rgba(32, 1, (x) => [-0.25 + x * 0.0625, 0.5, 0.25, 1], Float32Array),
    withIccCurve(iccCurve('curv', [0, 16384, 65535])),
    { bits: 32, exponentBits: 8 }
  )
  add('straight16', 3, 1, Uint16Array.of(1000, 2000, 3000, 32769, 4000, 5000, 6000, 0, 1, 2, 3, 1), srgb)
  add('premul16', 3, 1, Uint16Array.of(8192, 4096, 2048, 32768, 0, 0, 0, 0, 1, 1, 1, 1), srgb, {
    premultiplied: true
  })
  add(
    'orientation6',
    3,
    2,
    rgba(3, 2, (x, y, i) => [1000 + i * 5000, 2000 + x, 3000 + y, 65535]),
    srgb,
    { orientation: 6 }
  )
  return cases
}
