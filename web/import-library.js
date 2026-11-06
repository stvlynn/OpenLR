import { addPhoto } from './catalog.js'
import { photoPreviewVersions } from './decode.js'
import { decodeEditSource } from './edit-source.js'
import { processingVersion, PROCESS_MESSAGES } from './process-version.js'
import { isVideo, poster } from './video.js'
import { metadata } from './metadata.js'
import { readXmp } from './xmp.js'
import { renderPrepared as render } from './render.js'
import { encodeThumbnail } from './encode.js'

const importErrorNames = new Set([
  'SecurityError',
  'InvalidStateError',
  'NotSupportedError',
  'NotAllowedError',
  'AbortError',
  'DataError',
  'QuotaExceededError',
  'UnknownError',
  'TypeError',
  'Error'
])

function reportVideoImport(diagnostic, error) {
  try {
    const report = globalThis.mygo?.call?.(
      'Desktop.VideoImportDiagnostic',
      JSON.stringify({
        ...diagnostic,
        errorName: importErrorNames.has(error.name) ? error.name : 'other',
        secureContext: isSecureContext,
        documentOrigin: location.origin === 'null' ? 'opaque' : 'tuple',
        nativeScheme: location.protocol === 'mygo:',
        videoDecoder: typeof VideoDecoder === 'function',
        videoEncoder: typeof VideoEncoder === 'function',
        audioDecoder: typeof AudioDecoder === 'function',
        audioEncoder: typeof AudioEncoder === 'function'
      })
    )
    // Send the report independently of the original import result.
    report?.catch(() => {})
  } catch {
    // Diagnostics cannot replace the import error.
  }
}

async function sameFile(left, right) {
  if (!left || left.size !== right.size) return false
  const chunk = 1024 * 1024
  for (let i = 0; i < left.size; i += chunk) {
    const [a, b] = await Promise.all([left, right].map((file) => file.slice(i, i + chunk).arrayBuffer()))
    const bytes = new Uint8Array(b)
    if (new Uint8Array(a).some((value, index) => value !== bytes[index])) return false
  }
  return true
}
async function previouslyAdded(file, photos, readOriginal) {
  const name = file.name.toLowerCase()
  for (const p of photos) {
    if (
      p.virtual ||
      (p.sourceName || p.name).toLowerCase() !== name ||
      (p.byteSize !== undefined && p.byteSize !== file.size)
    )
      continue
    let original
    try {
      original = await readOriginal(p.id)
    } catch {
      continue
    }
    if (await sameFile(original?.file, file)) return p
  }
}
export async function importBatch(files, { photos, album, readOriginal, update, deduplicate = true }) {
  const added = [],
    existing = [],
    failed = []
  const stem = (name) => name.replace(/\.[^.]+$/, '').toLowerCase()
  const sidecars = new Map(files.filter((f) => /\.xmp$/i.test(f.name)).map((f) => [stem(f.name), f]))
  for (const file of files.filter((f) => !/\.xmp$/i.test(f.name))) {
    let image
    const video = isVideo(file),
      diagnostic =
        video && globalThis.openlrDiagnostics
          ? { stage: 'input', declaredVideoType: file.type.startsWith('video/') }
          : null
    try {
      const sidecar = sidecars.get(stem(file.name)),
        settings = sidecar ? readXmp(await sidecar.text()) : {}
      const duplicate = deduplicate ? await previouslyAdded(file, photos, readOriginal) : null
      if (duplicate) {
        if (album && !duplicate.albums.includes(album)) settings.albums = [...duplicate.albums, album]
        if (duplicate.deleted) settings.deleted = false
        if (Object.keys(settings).length) await update(duplicate, settings)
        existing.push(duplicate.id)
      } else {
        if (video && processingVersion(settings.edit) === 2) throw Error(PROCESS_MESSAGES.video)
        const media = video ? await poster(file, diagnostic) : null
        image = media?.bitmap ?? (await decodeEditSource(file, settings.edit))
        if (diagnostic) diagnostic.stage = 'photo-record'
        const p = {
          id: crypto.randomUUID(),
          name: file.name,
          sourceName: file.name,
          byteSize: file.size,
          width: image.width,
          height: image.height,
          added: Date.now(),
          rating: 0,
          flag: '',
          keywords: '',
          deleted: false,
          albums: album ? [album] : [],
          edit: {},
          mediaType: file.type,
          ...(media ? { duration: media.duration } : {}),
          metadata: media ? {} : await metadata(file),
          ...settings
        }
        if (diagnostic) diagnostic.stage = 'thumbnail-render'
        const thumbnail = await render(image, settings.edit || {}, 240)
        if (diagnostic) diagnostic.stage = 'thumbnail-encode'
        Object.assign(p, { thumbnail: encodeThumbnail(thumbnail), ...photoPreviewVersions(file) })
        if (diagnostic) diagnostic.stage = 'catalog-write'
        await addPhoto(p, file)
        photos.push(p)
        added.push(p.id)
      }
      if (sidecar) sidecars.delete(stem(file.name))
    } catch (error) {
      failed.push({ name: file.name, error: error.message })
      if (diagnostic) reportVideoImport(diagnostic, error)
    } finally {
      image?.close()
    }
  }
  for (const sidecar of sidecars.values()) {
    try {
      const targets = photos.filter((p) => !p.virtual && stem(p.sourceName || p.name) === stem(sidecar.name))
      if (targets.length !== 1) throw Error('Select the photo and use Apply XMP')
      await update(targets[0], readXmp(await sidecar.text()))
    } catch (error) {
      failed.push({ name: sidecar.name, error: error.message })
    }
  }
  return { added, existing, failed }
}
