import { normalizeExportSettings } from './export-settings.js'
import { isVideo, openVideo, clipRange, exportVideo } from './video.js'
import { decodeEditSource } from './edit-source.js'
import { processingVersion, neutralRecipe, PROCESS_MESSAGES } from './process-version.js'
import { exportDng } from './dng.js'
import { exportPackage, exportXmp } from './xmp.js'
import { exportFilename } from './formats.js'
import { validateExportColorSpace } from './export-color.js'
import { metadata } from './metadata.js'
import { workingFrame } from './working-frames.js'
import { renderPrepared as render, renderFramePrepared as renderFrame } from './render.js'
import { encodePhoto, encodeFrame } from './encode.js'
import { applyOutputSharpening, applyWatermark, applyFrameWatermark } from './export-options.js'
import { applyFrameOutputSharpening } from './output-sharpening.js'

// Shared preparation; callers own output completion and settings persistence.
export async function preparePhotoExport(
  p,
  args,
  { original, source: activeSource, preview = false, comparison = false, signal }
) {
  let ownedImage, ownedVideo, originalData
  const readOriginal = original
  original = async () => (originalData ??= await readOriginal(p.id))
  const source =
    activeSource ??
    (async () => {
      if (p.local?.sidecarError) throw Error(p.local.sidecarError)
      if (ownedImage) return ownedImage
      const { file } = await original()
      if (isVideo(file)) {
        if (processingVersion(p.edit) === 2) throw Error(PROCESS_MESSAGES.video)
        ownedVideo = await openVideo(file)
        await ownedVideo.seek(clipRange(p.edit.trim, ownedVideo.duration).start)
        ownedImage = await ownedVideo.frameAt()
      } else ownedImage = await decodeEditSource(file, p.edit)
      return ownedImage
    })
  try {
    signal?.throwIfAborted()
    const media = isVideo(p) ? 'video' : 'photo',
      options = !preview ? normalizeExportSettings(args, media) : null,
      finished = (result) => (options ? { ...result, exportSettings: { media, options } } : result)
    if (options) args = options
    const format = preview ? 'image/png' : (args.format ?? (isVideo(p) ? 'video/mp4' : 'image/jpeg'))
    const colorSpace = validateExportColorSpace(format, args.colorSpace)
    if (format.startsWith('video/')) {
      if (!isVideo(p)) throw Error('Select a video')
      await source(p.id)
      return finished(await exportVideo((await original(p.id)).file, p, { ...args, format, signal }))
    }
    if (format === 'original') return finished({ blob: (await original(p.id)).file, filename: p.name })
    if (format === 'image/x-adobe-dng') {
      return finished(await exportDng(p, (await original(p.id)).file))
    }
    if (format === 'original-settings') return finished(await exportPackage(p, (await original(p.id)).file))
    if (format === 'application/rdf+xml')
      return finished({
        blob: new Blob([exportXmp(p)], { type: format }),
        filename: exportFilename(p.name, format)
      })
    const max = args.maxSize === undefined ? (preview ? 1280 : Infinity) : args.maxSize
    const metadataOptions =
      !preview && args.metadata && args.metadata !== 'none'
        ? {
            policy: args.metadata,
            source: await metadata((await original(p.id)).file, { strict: true })
          }
        : undefined
    const image = await source(p.id)
    const recipe = preview && comparison ? neutralRecipe(p.edit) : p.edit
    if (processingVersion(recipe) === 2) {
      const frame = await renderFrame(workingFrame(image), recipe, max, { signal })
      if (!preview) {
        applyFrameOutputSharpening(frame, args.outputSharpening)
        applyFrameWatermark(frame, args.watermark)
      }
      return finished({
        blob: await encodeFrame(frame, format, args.quality ?? 0.92, colorSpace, metadataOptions),
        filename: exportFilename(p.name, format)
      })
    }
    const canvas = await render(image, recipe, max, { signal })
    if (!preview) {
      applyOutputSharpening(canvas, args.outputSharpening)
      applyWatermark(canvas, args.watermark)
    }
    return finished({
      blob: await encodePhoto(canvas, format, args.quality ?? 0.92, colorSpace, metadataOptions),
      filename: exportFilename(p.name, format)
    })
  } catch (error) {
    if (signal?.aborted && error.name === 'AbortError') throw signal.reason
    throw error
  } finally {
    ownedVideo?.close()
    if (!ownedVideo) ownedImage?.close?.()
  }
}
