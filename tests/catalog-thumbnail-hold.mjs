// Keep the real encoder and suspend one catalog write while it reads the new thumbnail.
export function holdCatalogThumbnail(page) {
  return page.evaluate(() => {
    const slice = Blob.prototype.slice
    const hold = (window.catalogThumbnailHold = { release: null })
    Blob.prototype.slice = function (...args) {
      const part = slice.apply(this, args)
      if (this.type !== 'image/jpeg' || this instanceof File) return part
      Blob.prototype.slice = slice
      const read = part.arrayBuffer.bind(part)
      part.arrayBuffer = async () => {
        const bytes = await read()
        await new Promise((resolve) => (hold.release = resolve))
        return bytes
      }
      return part
    }
  })
}
