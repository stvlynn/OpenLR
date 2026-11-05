import { PNG_SIGNATURE, pngChunks } from './png-container.js'
import { orientPixels } from './pixel-orientation.js'

// WebKit and Chromium differ in applying PNG eXIf orientation. Remove it only
// from the temporary decode source, then orient the host-color-managed pixels.
export async function decodePngDisplay(file, input) {
  const bytes = input ? new Uint8Array(input) : new Uint8Array(await file.arrayBuffer()),
    parts = [PNG_SIGNATURE]
  let offset = PNG_SIGNATURE.length,
    exif
  // Leave display-codec integrity policy to the host; numeric reconstruction
  // and exports retain the container iterator's strict default CRC checks.
  for (const { type, data } of pngChunks(bytes, { verifyCrc: false })) {
    const end = offset + data.length + 12
    if (type === 'eXIf') exif = data
    else parts.push(bytes.subarray(offset, end))
    offset = end
  }
  const orientation = exif ? await (await import('./vendor/exifr/exifr.js')).orientation(exif) : 1
  if (!Number.isInteger(orientation) || orientation < 2 || orientation > 8) return createImageBitmap(file)
  const bitmap = await createImageBitmap(new Blob(parts, { type: 'image/png' }))
  try {
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    const oriented = orientPixels(context.getImageData(0, 0, bitmap.width, bitmap.height), orientation)
    return await createImageBitmap(new ImageData(oriented.data, oriented.width, oriented.height))
  } finally {
    bitmap.close()
  }
}
