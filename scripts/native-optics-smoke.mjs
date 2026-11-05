import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { makePng } from '../tests/fixtures/png.mjs'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const width = 128,
  height = 96

function cameraExif() {
  const bytes = Buffer.alloc(104)
  const entry = (offset, tag, type, count, value) => {
    bytes.writeUInt16LE(tag, offset)
    bytes.writeUInt16LE(type, offset + 2)
    bytes.writeUInt32LE(count, offset + 4)
    bytes.writeUInt32LE(value, offset + 8)
  }
  bytes.write('II')
  bytes.writeUInt16LE(42, 2)
  bytes.writeUInt32LE(8, 4)
  bytes.writeUInt16LE(3, 8)
  entry(10, 271, 2, 6, 50) // Make, ASCII
  entry(22, 272, 2, 19, 56) // Model, ASCII
  entry(34, 34665, 4, 1, 76) // Exif IFD pointer
  bytes.write('Canon\0Canon PowerShot G1\0', 50)
  bytes.writeUInt16LE(1, 76)
  entry(78, 37386, 5, 1, 96) // FocalLength, rational 146/10
  bytes.writeUInt32LE(146, 96)
  bytes.writeUInt32LE(10, 100)
  return bytes
}

function generatedScene() {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let pixel = [64, 64, 64, 255]
      if (x < 8 && y < 22) pixel = [0, 0, 0, 255]
      if (x >= 24 && x <= 32 && y >= 18 && y <= 24) pixel = [160, 40, 20, 255]
      if (x >= 20 && x <= 108 && Math.abs(y - (48 + (x - 64) / 4)) <= 1.25) pixel = [240, 240, 240, 255]
      if (x >= 112 && y >= 80) pixel = [0, 0, 0, 0]
      data.set(pixel, (y * width + x) * 4)
    }
  }
  return data
}

function expectedBins(data) {
  const bins = Object.fromEntries(['red', 'green', 'blue', 'luma'].map((name) => [name, Array(256).fill(0)]))
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = data.subarray(i, i + 4)
    if (!a) continue
    bins.red[r]++
    bins.green[g]++
    bins.blue[b]++
    bins.luma[Math.round((2126 * r + 7152 * g + 722 * b) / 10000)]++
  }
  return bins
}

function pixel({ data, width }, x, y) {
  const offset = (y * width + x) * 4
  return Array.from(data.subarray(offset, offset + 4))
}

function brightLineCenter(image, x) {
  let total = 0,
    weightedY = 0
  for (let y = 25; y <= 70; y++) {
    const [red, , , alpha] = pixel(image, x, y)
    const weight = Math.max(0, red - 170) * (alpha / 255)
    total += weight
    weightedY += weight * y
  }
  assert.ok(total > 100, `Expected a bright reference at column ${x}`)
  return weightedY / total
}

const dims = ({ width, height }) => [width, height]
function assertSameImage(actual, expected) {
  assert.deepEqual(dims(actual), dims(expected))
  assert.deepEqual(actual.data, expected.data)
}

await withNativeWorkspace(process.argv[2], async ({ root, call, initial }) => {
  assert.deepEqual(initial.photos, [])
  const input = path.join(root, 'calibration-scene.png')
  const source = generatedScene()
  const original = Buffer.from(
    makePng({ width, height, bits: 8, colorType: 6, data: source, exif: cameraExif() })
  )
  await writeFile(input, original)
  const imported = await call('import', input)
  assert.deepEqual(imported.failed, [])
  assert.equal(imported.added.length, 1)
  const [id] = imported.added
  const row = (snapshot) => snapshot.photos.find((photo) => photo.id === id)
  const state = () => call('state')
  const edit = (key, value) => call('edit', '--args', JSON.stringify({ key, value }))
  const geometry = (name, args = {}) => call(name, '--args', JSON.stringify({ photoId: id, ...args }))
  const exported = async (name) => {
    const output = await call('export', '--format', 'image/png', '--output', path.join(root, name + '.png'))
    assert.equal(output.mimeType, 'image/png')
    const image = readPng(await readFile(output.path))
    return {
      width: image.width,
      height: image.height,
      data: Uint8Array.from(image.data, (v) => Math.round(v * 255))
    }
  }

  const photo = row(await call('view', '--mode', 'detail'))
  assert.deepEqual(
    { make: photo.metadata.Make, model: photo.metadata.Model, focal: photo.metadata.FocalLength },
    {
      make: 'Canon',
      model: 'Canon PowerShot G1',
      focal: 14.6
    }
  )
  assert.deepEqual(await call('histogram'), expectedBins(source))

  const crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }
  await edit('crop', crop)
  await edit('Exposure', -0.5)
  const beforeAuto = await exported('before-auto-tone')
  const autoTone = await call('auto-tone')
  // The input's opaque majority is sRGB 64. Convert that median to linear
  // light and meter it to 18 percent, rounded to the CLI's 0.05 EV increment.
  const median = ((64 / 255 + 0.055) / 1.055) ** 2.4
  const exposure = Math.round(20 * Math.log2(0.18 / median)) / 20
  assert.equal(exposure, 1.8)
  assert.deepEqual(row(autoTone).edit, { crop, Exposure: exposure })
  const toned = await exported('auto-tone')
  assert.deepEqual(dims(toned), [width / 2, height / 2])
  assert.ok(pixel(toned, 8, 8)[0] > pixel(beforeAuto, 8, 8)[0] + 40)
  assert.deepEqual(await call('histogram'), expectedBins(toned.data))
  assert.deepEqual(row(await call('undo')).edit, { crop, Exposure: -0.5 })
  assertSameImage(await exported('undone-auto-tone'), beforeAuto)
  assert.equal((await call('compare')).compare, true)
  assert.deepEqual(row(await call('auto-tone')).edit, { crop, Exposure: exposure })
  assertSameImage(await exported('auto-tone-in-compare'), toned)
  assert.equal((await call('compare')).compare, false)

  const baseline = row(await edit('crop', null)).edit
  const uncorrected = await exported('uncorrected')
  assert.deepEqual(dims(uncorrected), [width, height])
  const match = await call('lens-match')
  assert.deepEqual(row(await state()).edit, baseline)
  assert.equal(match.cameras.length, 1)
  assert.equal(match.cameras[0].model, photo.metadata.Model)
  assert.equal(match.cameras[0].cropFactor, 4.843)
  const candidate = match.profiles.find(
    (item) => item.model === 'Canon PowerShot G1 & compatibles (Standard)'
  )
  assert.ok(candidate?.distortion)
  const lensEdit = row(await geometry('lens-apply', { id: candidate.id })).edit
  const { optics } = lensEdit
  const { profile } = optics
  assert.deepEqual(lensEdit, { ...baseline, optics })
  assert.equal(optics.enabled, true)
  assert.equal(optics.profileDistortion, true)
  assert.equal(profile.id, candidate.id)
  assert.equal(profile.focal, 14.6)
  assert.equal(profile.cropFactor, 4.843)
  assert.equal(profile.distortion.model, 'ptlens')
  assert.ok(profile.distortion.b > 0)
  assert.equal(profile.source, 'compact-canon.xml')
  assert.equal(profile.sourceCommit, match.source.commit)
  assert.equal(profile.license, 'CC-BY-SA-3.0')
  const profiled = await exported('profiled')
  assert.deepEqual(dims(profiled), [width, height])
  const profileEdge = [pixel(uncorrected, 8, 8)[0], pixel(profiled, 8, 8)[0]]
  const profileCornerAlpha = [pixel(uncorrected, 0, 0)[3], pixel(profiled, 0, 0)[3]]
  assert.ok(profileEdge[1] < profileEdge[0] - 3, JSON.stringify(profileEdge))
  assert.ok(profileCornerAlpha[1] < profileCornerAlpha[0] - 20, JSON.stringify(profileCornerAlpha))
  assert.deepEqual(pixel(profiled, 64, 64), pixel(uncorrected, 64, 64))

  // An integer 16-pixel translation has an exact pixel oracle, independent of
  // the lens coefficients. Disabling their application retains the profile.
  const shift = { shiftX: 12.5, profileDistortion: false }
  const shiftedEdit = row(await geometry('optics', { changes: shift })).edit
  assert.deepEqual(shiftedEdit, { ...baseline, optics: { ...optics, ...shift } })
  const shifted = await exported('shifted')
  assert.deepEqual(dims(shifted), [width, height])
  assert.deepEqual(pixel(shifted, 44, 21), pixel(uncorrected, 28, 21))
  assert.deepEqual(pixel(shifted, 28, 21), pixel(uncorrected, 12, 21))
  assert.notDeepEqual(pixel(shifted, 28, 21), pixel(uncorrected, 28, 21))
  assert.deepEqual(pixel(shifted, 15, 30), [0, 0, 0, 0])
  assert.deepEqual(pixel(shifted, 16, 30), pixel(uncorrected, 0, 30))
  assert.deepEqual(row(await geometry('optics-reset')).edit, baseline)
  assertSameImage(await exported('reset-optics'), uncorrected)

  const point = (x, y) => ({ x: (x + 0.5) / width, y: (y + 0.5) / height })
  const start = point(24, 38),
    end = point(104, 58)
  const reference = { start, end, axis: 'horizontal' }
  await assert.rejects(geometry('straighten', { ...reference, end: start }), /two distinct points/)
  await assert.rejects(geometry('straighten', { ...reference, photoId: 'stale' }), /selected photo changed/)
  assert.deepEqual(row(await state()).edit, baseline)
  const straightEdit = row(await geometry('straighten', reference)).edit
  const expectedAngle = -(Math.atan2(20, 80) * 180) / Math.PI
  assert.ok(Math.abs(straightEdit.optics.rotate - expectedAngle) < 1e-6)
  assert.deepEqual(straightEdit, { ...baseline, optics: straightEdit.optics })
  const straight = await exported('straight')
  assert.deepEqual(dims(straight), [width, height])
  const tilt = (image) => brightLineCenter(image, 96) - brightLineCenter(image, 32)
  const referenceTilt = [tilt(uncorrected), tilt(straight)]
  assert.ok(Math.abs(referenceTilt[0] - 16) < 0.1, JSON.stringify(referenceTilt))
  assert.ok(Math.abs(referenceTilt[1]) <= 2, JSON.stringify(referenceTilt))
  assert.deepEqual(row(await call('undo')).edit, baseline)
  assertSameImage(await exported('undone-straighten'), uncorrected)
  assert.deepEqual(row(await call('redo')).edit, straightEdit)
  assertSameImage(await exported('redone-straighten'), straight)

  const preserved = await call('export', '--format', 'original', '--output', path.join(root, 'original.png'))
  assert.deepEqual(await readFile(preserved.path), original)
  assert.deepEqual(await readFile(input), original)
  console.log(
    JSON.stringify({
      nativeOptics: 'passed',
      autoExposure: exposure,
      autoToneGray: [pixel(beforeAuto, 8, 8)[0], pixel(toned, 8, 8)[0]],
      profile: { focal: profile.focal, cropFactor: profile.cropFactor, coefficient: profile.distortion.b },
      profileEdge,
      profileCornerAlpha,
      shiftPixels: 16,
      straightenDegrees: straightEdit.optics.rotate,
      referenceTilt,
      preservedOriginals: 1
    })
  )
})
