// EXIF/TIFF orientation moves complete pixels without changing their samples.
export function orientPixels(pixels, orientation) {
  if (!orientation || orientation === 1) return pixels
  const { width, height, data } = pixels,
    swapped = orientation >= 5 && orientation <= 8,
    w = swapped ? height : width,
    h = swapped ? width : height,
    out = new data.constructor(w * h * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let u = x,
        v = y
      if (orientation === 2) u = width - 1 - x
      if (orientation === 3) {
        u = width - 1 - x
        v = height - 1 - y
      }
      if (orientation === 4) v = height - 1 - y
      if (orientation === 5) {
        u = y
        v = x
      }
      if (orientation === 6) {
        u = height - 1 - y
        v = x
      }
      if (orientation === 7) {
        u = height - 1 - y
        v = width - 1 - x
      }
      if (orientation === 8) {
        u = y
        v = width - 1 - x
      }
      out.set(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (v * w + u) * 4)
    }
  return { ...pixels, width: w, height: h, data: out }
}
