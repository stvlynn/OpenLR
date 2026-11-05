import { decodePhoto, decodePhotoFrame } from './decode.js'
import { linearFrameToRgba8 } from './pixel-frame.js'
import { bindWorkingFrame } from './working-frames.js'
import { processingVersion, PROCESS_MESSAGES } from './process-version.js'
import { isVideo } from './video.js'

export async function decodeEditSource(file, recipe = {}) {
  if (processingVersion(recipe) === 1) return decodePhoto(file)
  if (isVideo(file)) throw new Error(PROCESS_MESSAGES.video)
  const frame = await decodePhotoFrame(file)
  const pixels = linearFrameToRgba8(frame)
  const surface = await createImageBitmap(new ImageData(pixels.data, pixels.width, pixels.height))
  return bindWorkingFrame(surface, frame)
}
