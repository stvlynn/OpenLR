import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makePng } from '../tests/fixtures/png.mjs'
import { readPng } from '../web/png.js'
import { withNativeWorkspace } from './native-workspace.mjs'

const portrait = fileURLToPath(new URL('../tests/fixtures/ai/astronaut.png', import.meta.url))
const persistent = ['win32', 'linux'].includes(process.platform)
const flashRgb = [245, 29, 22]
const control = [6, 6]
const dims = ({ width, height }) => [width, height]

function decode(bytes) {
  const { width, height, data } = readPng(bytes)
  return { width, height, data: Uint8Array.from(data, (value) => Math.round(value * 255)) }
}

function pixel({ width, data }, x, y) {
  const offset = (y * width + x) * 4
  return Array.from(data.subarray(offset, offset + 4))
}

function fixtureBytes({ width, height, data }) {
  const rgb = new Uint8Array(width * height * 3)
  for (let p = 0; p < width * height; p++) rgb.set(data.subarray(p * 4, p * 4 + 3), p * 3)
  return Buffer.from(makePng({ width, height, bits: 8, data: rgb }))
}

// Soften the same scene with an independent separable nine-pixel box filter.
function soften({ width, height, data }) {
  const horizontal = new Float64Array(data.length)
  const blurred = new Uint8Array(data.length)
  const radius = 4,
    diameter = radius * 2 + 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      for (let dx = -radius; dx <= radius; dx++) {
        const column = Math.max(0, Math.min(width - 1, x + dx))
        for (let c = 0; c < 3; c++) horizontal[offset + c] += data[(y * width + column) * 4 + c] / diameter
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        let value = 0
        for (let dy = -radius; dy <= radius; dy++) {
          const row = Math.max(0, Math.min(height - 1, y + dy))
          value += horizontal[(row * width + x) * 4 + c]
        }
        blurred[offset + c] = Math.round(value / diameter)
      }
      blurred[offset + 3] = 255
    }
  }
  return { width, height, data: blurred }
}

function checkClipping(review, { width, height, data }) {
  assert.deepEqual([review.width, review.height], [width, height])
  assert.ok(Number.isFinite(review.focus) && review.focus > 0)
  let black = 0,
    white = 0
  for (let i = 0; i < data.length; i += 4) {
    const luma = (2126 * data[i] + 7152 * data[i + 1] + 722 * data[i + 2]) / 10000
    if (luma < 3.5) black++
    if (luma >= 251.5) white++
  }
  assert.equal(review.black, black / (width * height))
  assert.equal(review.white, white / (width * height))
}

function checkFace(review) {
  assert.ok(review.faces.length >= 1, 'YuNet should detect the fixture portrait')
  const [face] = review.faces
  assert.ok(face.confidence > 0.8 && face.confidence <= 1)
  assert.ok(
    face.x >= 0 && face.y >= 0 && face.w > 0 && face.h > 0 && face.x + face.w <= 1 && face.y + face.h <= 1
  )
  assert.equal(face.eyes.length, 2)
  for (const { x, y, rx, ry, detail } of face.eyes) {
    assert.ok(x > face.x && x < face.x + face.w && y > face.y && y < face.y + face.h)
    assert.ok(rx > 0 && ry > 0 && Number.isFinite(detail) && detail > 0)
  }
  assert.ok(Math.abs(face.eyes[0].x - face.eyes[1].x) > 0.02)
  return face
}

await withNativeWorkspace(
  process.argv[2],
  async ({ root, call, initial, restart }) => {
    assert.deepEqual(initial.photos, [])
    const run = (command, args) => call(command, '--args', JSON.stringify(args))
    const state = () => call('state')
    const select = (id) => run('select', { id })
    const row = (snapshot, id) => snapshot.photos.find((photo) => photo.id === id)
    async function imported(file) {
      const { added, failed } = await call('import', file)
      assert.deepEqual(failed, [])
      assert.equal(added.length, 1)
      return added[0]
    }
    async function rendered(name) {
      const output = await call('export', '--format', 'image/png', '--output', path.join(root, name + '.png'))
      assert.equal(output.mimeType, 'image/png')
      return decode(await readFile(output.path))
    }
    const portraitBytes = await readFile(portrait)
    const sharpId = await imported(portrait)
    const sharp = await rendered('sharp-display')
    assert.deepEqual(dims(sharp), [512, 512])
    const blurred = soften(sharp)
    const blurredBytes = fixtureBytes(blurred)
    const softFile = path.join(root, 'soft.png')
    await writeFile(softFile, blurredBytes)
    const softId = await imported(softFile)
    const ordered = [softId, sharpId]
    await run('select-many', { ids: [sharpId, softId] })
    const beforeCull = await state()
    await assert.rejects(() => run('cull', { expectedIds: [sharpId] }), /selection changed/i)
    const { scores } = await run('cull', { ids: ordered, expectedIds: ordered })
    assert.deepEqual(
      scores.map(({ id }) => id),
      ordered
    )
    const [softReview, sharpReview] = scores.map(({ review }) => review)
    checkClipping(softReview, blurred)
    checkClipping(sharpReview, sharp)
    const face = checkFace(sharpReview)
    assert.ok(sharpReview.focus > 2 * softReview.focus)
    const reviewed = await state()
    assert.deepEqual(reviewed.selection, beforeCull.selection)
    for (const { id, review } of scores) {
      const saved = row(reviewed, id)
      assert.deepEqual(saved.review, review)
      assert.deepEqual(saved.edit, row(beforeCull, id).edit)
      assert.deepEqual(saved.metadata, row(beforeCull, id).metadata)
    }

    // Use the measured landmark as a placement reference, then re-detect the
    // face in a new imported file without borrowing the original's saved review.
    const [eye] = face.eyes
    const pupil = [Math.round(eye.x * sharp.width), Math.round(eye.y * sharp.height)]
    const flash = { ...sharp, data: sharp.data.slice() }
    for (const [x, y] of [pupil, control]) {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          flash.data.set([...flashRgb, 255], ((y + dy) * flash.width + x + dx) * 4)
    }
    const flashBytes = fixtureBytes(flash)
    const flashFile = path.join(root, 'flash.png')
    await writeFile(flashFile, flashBytes)
    const flashId = await imported(flashFile)
    const timestamp = '2024-03-17T12:34:56.000Z'
    await run('capture-time', { time: timestamp })
    await run('rate', { value: 3 })
    const beforeAuto = row(await state(), flashId)
    assert.equal(beforeAuto.metadata.DateTimeOriginal, timestamp)
    assert.equal(beforeAuto.rating, 3)
    assert.equal(beforeAuto.review, undefined)
    const redInput = await rendered('before-auto-eye')
    assert.deepEqual(redInput, flash)
    await assert.rejects(() => call('red-eye', '--photoId', sharpId), /selected photo changed/i)
    const corrected = await call('red-eye', '--photoId', flashId)
    assert.ok(corrected.eyeRegions >= 2)
    const afterAuto = row(await state(), flashId)
    assert.equal(afterAuto.edit.redEyes.length, corrected.eyeRegions)
    assert.deepEqual(afterAuto.metadata, beforeAuto.metadata)
    assert.equal(afterAuto.rating, beforeAuto.rating)
    const redOutput = await rendered('after-auto-eye')
    assert.deepEqual(dims(redOutput), dims(redInput))
    const correctedPupil = pixel(redOutput, ...pupil)
    assert.ok(correctedPupil[0] < 100, JSON.stringify(correctedPupil))
    assert.deepEqual(correctedPupil.slice(1), [29, 22, 255])
    assert.deepEqual(pixel(redOutput, ...control), [...flashRgb, 255])

    const [{ review: flashReview }] = (await run('cull', { ids: [flashId] })).scores
    checkClipping(flashReview, redInput)
    checkFace(flashReview)
    assert.deepEqual(
      afterAuto.edit.redEyes,
      flashReview.faces.flatMap(({ eyes }) => eyes.map(({ x, y, rx, ry }) => ({ x, y, rx, ry })))
    )
    const inputPixels = new Uint32Array(redInput.data.buffer),
      correctedPixels = new Uint32Array(redOutput.data.buffer)
    let changed = 0
    for (let i = 0; i < inputPixels.length; i++) {
      if (inputPixels[i] === correctedPixels[i]) continue
      const offset = i * 4
      assert.ok(redOutput.data[offset] < redInput.data[offset], 'Red-eye reduces only the red channel')
      assert.deepEqual(
        redOutput.data.subarray(offset + 1, offset + 4),
        redInput.data.subarray(offset + 1, offset + 4)
      )
      const x = ((i % redInput.width) + 0.5) / redInput.width,
        y = (Math.floor(i / redInput.width) + 0.5) / redInput.height
      assert.ok(
        afterAuto.edit.redEyes.some((eye) => ((x - eye.x) / eye.rx) ** 2 + ((y - eye.y) / eye.ry) ** 2 < 1),
        'Red-eye changes belong to a detected eye'
      )
      changed++
    }
    assert.ok(changed >= 9)
    const undone = row(await call('undo'), flashId)
    assert.deepEqual(undone.edit, beforeAuto.edit)
    assert.deepEqual(undone.metadata, beforeAuto.metadata)
    assert.deepEqual(undone.review, flashReview)
    assert.deepEqual(await rendered('undone-auto-eye'), redInput)
    const redone = row(await call('redo'), flashId)
    assert.deepEqual(redone.edit, afterAuto.edit)
    assert.deepEqual(await rendered('redone-auto-eye'), redOutput)

    const final = persistent ? await restart() : await state()
    assert.deepEqual(row(final, flashId).edit, afterAuto.edit)
    assert.deepEqual(row(final, flashId).metadata, beforeAuto.metadata)
    for (const { id, review } of [...scores, { id: flashId, review: flashReview }])
      assert.deepEqual(row(final, id).review, review)
    for (const [index, [id, input, bytes]] of [
      [sharpId, portrait, portraitBytes],
      [softId, softFile, blurredBytes],
      [flashId, flashFile, flashBytes]
    ].entries()) {
      await select(id)
      const output = await call(
        'export',
        '--format',
        'original',
        '--output',
        path.join(root, `original-${index}.png`)
      )
      assert.deepEqual(await readFile(output.path), bytes)
      assert.deepEqual(await readFile(input), bytes)
    }
    console.log(
      JSON.stringify({
        nativeCulling: 'passed',
        focus: { sharp: sharpReview.focus, soft: softReview.focus },
        clipping: {
          sharp: [sharpReview.black, sharpReview.white],
          soft: [softReview.black, softReview.white]
        },
        faceConfidence: face.confidence,
        eyes: face.eyes,
        automaticRedEye: {
          regions: corrected.eyeRegions,
          pupilBefore: [...flashRgb, 255],
          pupilAfter: correctedPupil,
          control: pixel(redOutput, ...control),
          changed
        },
        persistentReload: persistent,
        preservedOriginals: 3
      })
    )
  },
  { persistent }
)
