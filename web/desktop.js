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
export async function writeNativeExport(blob, id, { signal, onProgress } = {}) {
  const encode = (chunk) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1])
      reader.onerror = () => reject(reader.error ?? new Error('Cannot read the exported image'))
      reader.readAsDataURL(chunk)
    })
  try {
    signal?.throwIfAborted()
    const chunkSize = 512 * 1024
    onProgress?.({ writtenBytes: 0, totalBytes: blob.size })
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      signal?.throwIfAborted()
      const encoded = await encode(blob.slice(offset, offset + chunkSize))
      signal?.throwIfAborted()
      await globalThis.mygo.call('Desktop.WriteExport', id, encoded)
      onProgress?.({ writtenBytes: Math.min(offset + chunkSize, blob.size), totalBytes: blob.size })
    }
    signal?.throwIfAborted()
    await globalThis.mygo.call('Desktop.FinishExport', id)
    // Publication is the commit point; a later cancellation cannot undo this file.
    return true
  } catch (error) {
    await globalThis.mygo.call('Desktop.CancelExport', id).catch((cleanup) => {
      if (error && typeof error === 'object') error.cleanupError = cleanup.message || String(cleanup)
    })
    throw error
  }
}

function exportBasename(filename) {
  let name = String(filename)
    .split(/[\\/]/)
    .at(-1)
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
  if (!name || name === '.' || name === '..') name = 'OpenLR-export'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name
  return name
}

/** Open a destination once; each write completes before the next image is decoded. */
export async function beginExportFolder(outputDirectory) {
  if (globalThis.mygo?.call) {
    const folder = await globalThis.mygo.call('Desktop.BeginExportFolder', outputDirectory ?? '')
    if (!folder) return null
    let closed = false
    return {
      async write(blob, filename, options = {}) {
        if (closed) throw Error('The export folder is closed')
        if (!(blob instanceof Blob) || !blob.size) throw Error('The exported image is empty')
        options.signal?.throwIfAborted()
        const transfer = await globalThis.mygo.call(
          'Desktop.BeginFolderExport',
          folder.id,
          exportBasename(filename)
        )
        await writeNativeExport(blob, transfer.id, options)
        return { path: transfer.path, filename: transfer.filename, bytes: blob.size }
      },
      async close() {
        if (closed) return
        closed = true
        await globalThis.mygo.call('Desktop.EndExportFolder', folder.id)
      }
    }
  }
  if (outputDirectory !== undefined) throw Error('A filesystem path requires the desktop app')
  if (!globalThis.showDirectoryPicker)
    throw Error('Folder export requires the desktop app or a browser with folder access')
  let directory
  try {
    directory = await globalThis.showDirectoryPicker({ mode: 'readwrite' })
  } catch (error) {
    if (error.name === 'AbortError') return null
    throw error
  }
  let closed = false
  return {
    async write(blob, filename, { signal, onProgress } = {}) {
      if (closed) throw Error('The export folder is closed')
      if (!(blob instanceof Blob) || !blob.size) throw Error('The exported image is empty')
      signal?.throwIfAborted()
      const used = new Set()
      for await (const name of directory.keys()) {
        signal?.throwIfAborted()
        used.add(name.toLowerCase())
      }
      const basename = exportBasename(filename),
        dot = basename.lastIndexOf('.')
      const stem = dot > 0 ? basename.slice(0, dot) : basename,
        extension = dot > 0 ? basename.slice(dot) : ''
      let chosen = basename
      for (let number = 2; used.has(chosen.toLowerCase()); number++) chosen = `${stem}-${number}${extension}`
      signal?.throwIfAborted()
      const file = await directory.getFileHandle(chosen, { create: true })
      let stream
      try {
        signal?.throwIfAborted()
        stream = await file.createWritable()
        const chunkSize = 512 * 1024
        onProgress?.({ writtenBytes: 0, totalBytes: blob.size })
        for (let offset = 0; offset < blob.size; offset += chunkSize) {
          signal?.throwIfAborted()
          await stream.write(blob.slice(offset, offset + chunkSize))
          onProgress?.({ writtenBytes: Math.min(offset + chunkSize, blob.size), totalBytes: blob.size })
        }
        signal?.throwIfAborted()
        await stream.close()
      } catch (error) {
        await stream?.abort().catch((cleanup) => {
          if (error && typeof error === 'object') error.cleanupError = cleanup.message || String(cleanup)
        })
        throw error
      }
      return { path: directory.name + '/' + chosen, filename: chosen, bytes: blob.size }
    },
    async close() {
      closed = true
    }
  }
}
