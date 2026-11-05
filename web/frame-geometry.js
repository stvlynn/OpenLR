import { geometry } from './geometry.js'
import { assertLinearFrame, sampleLinearRgba } from './pixel-frame.js'

// Crop bounds are expressed against reference, while frame may be a smaller
// preview. Quarter turns/reflections copy exact pixel centers without sampling.
export function transformFrame(frame, edit = {}, maxSize = Infinity, reference = frame) {
  assertLinearFrame(frame)
  const geom = geometry(reference, edit, maxSize)
  return resampleGeometry(frame, geom, reference)
}

export function resizeFrame(frame, width, height) {
  assertLinearFrame(frame)
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1)
    throw new TypeError('Frame dimensions must be positive integers')
  return resampleGeometry(
    frame,
    { x: 0, y: 0, w: frame.width, h: frame.height, width, height, turn: 0, flip: false },
    frame
  )
}

function resampleGeometry(frame, geom, reference) {
  const { width, height, flip } = geom,
    turn = ((geom.turn % 4) + 4) % 4,
    outputWidth = turn % 2 ? height : width,
    outputHeight = turn % 2 ? width : height,
    scaleX = frame.width / reference.width,
    scaleY = frame.height / reference.height
  if (
    !turn &&
    !flip &&
    geom.x === 0 &&
    geom.y === 0 &&
    geom.w === reference.width &&
    geom.h === reference.height &&
    width === frame.width &&
    height === frame.height
  )
    return frame
  const data = new Float32Array(outputWidth * outputHeight * 4),
    sample = new Float64Array(4)
  for (let y = 0; y < outputHeight; y++)
    for (let x = 0; x < outputWidth; x++) {
      let u, v
      if (turn === 0) {
        u = x
        v = y
      } else if (turn === 1) {
        u = y
        v = height - 1 - x
      } else if (turn === 2) {
        u = width - 1 - x
        v = height - 1 - y
      } else {
        u = width - 1 - y
        v = x
      }
      if (flip) u = width - 1 - u
      const sx = Math.max(
          0,
          Math.min(frame.width - 1, (geom.x + ((u + 0.5) * geom.w) / width) * scaleX - 0.5)
        ),
        sy = Math.max(0, Math.min(frame.height - 1, (geom.y + ((v + 0.5) * geom.h) / height) * scaleY - 0.5)),
        ix = Math.round(sx),
        iy = Math.round(sy),
        offset = (y * outputWidth + x) * 4
      if (Math.abs(ix - sx) < 1e-10 && Math.abs(iy - sy) < 1e-10) {
        const sourceOffset = (iy * frame.width + ix) * 4
        for (let channel = 0; channel < 4; channel++)
          data[offset + channel] = frame.data[sourceOffset + channel]
      } else if (sampleLinearRgba(frame, sx, sy, sample)) data.set(sample, offset)
    }
  return { ...frame, width: outputWidth, height: outputHeight, data }
}
