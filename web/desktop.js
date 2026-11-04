/** Save an exported Blob. Returns false when the native dialog is canceled. */
export async function saveExport(blob, filename) {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error('The exported image is empty')
  }
  if (globalThis.mygo?.call) {
    const id = await globalThis.mygo.call('Desktop.BeginExport', filename)
    if (!id) return false
    return await writeNativeExport(blob, id)
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return true
}

/** Send an existing native transfer in bounded-memory chunks. */
export async function writeNativeExport(blob, id) {
  const encode = (chunk) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1])
      reader.onerror = () => reject(reader.error ?? new Error('Cannot read the exported image'))
      reader.readAsDataURL(chunk)
    })
  try {
    const chunkSize = 512 * 1024
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      const encoded = await encode(blob.slice(offset, offset + chunkSize))
      await globalThis.mygo.call('Desktop.WriteExport', id, encoded)
    }
    await globalThis.mygo.call('Desktop.FinishExport', id)
    return true
  } catch (error) {
    await globalThis.mygo.call('Desktop.CancelExport', id).catch(() => {})
    throw error
  }
}
