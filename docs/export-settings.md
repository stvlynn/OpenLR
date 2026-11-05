# Reusing export settings

**Export again** and Ctrl/Command-E export the active photo or video with its last completed settings. The native File menu's **Export with previous settings** and `export-previous` command use the same operation. Without usable settings, the GUI opens Export; the CLI reports `Choose export settings first`. Ordinary Export restores the last completed options, so cancelling a draft does not change the next export.

Photos and videos have independent settings, retained across restart. Each record contains the effective format, supported quality and color space, and applicable long-edge size and watermark. Reuse renders the current asset and edits; it does not reuse an earlier image. Existing format constraints still apply, including RAW-only DNG output. Exporting a still frame from a video remains supported and updates the video slot.

Rendered exports also remember the selected [photo metadata policy](export-metadata.md). An omitted or `none` policy preserves the prior default; non-default policies re-read the current original's fields rather than reusing another photo's metadata. Cancellation and failed output keep the previous policy with the other settings.

The independent [output sharpening](output-sharpening.md) level is remembered with rendered photo options, including still-frame exports from video. Its default `none` is omitted from storage; non-default levels are applied to the current image at the current output size. It does not change recipe Sharpening or preview behavior.

```sh
node cli/openlr.mjs export --format image/png --colorSpace display-p3 --maxSize 1600 --output first.png
node cli/openlr.mjs export-previous --output next.png
node cli/openlr.mjs export-settings
node cli/openlr.mjs export-settings --media photo --options '{"format":"image/tiff","colorSpace":"prophoto-rgb"}'
```

`export-settings` reads `{photo,video}` without requiring a selected asset. A missing or invalid slot is `null`. Supplying both `media` and `options` explicitly replaces one slot; `options` uses the same validation as `export`. This explicit configuration operation does not itself produce a file. Output paths are adapter arguments and are never remembered.

## Completion and persistence

Preparing bytes is separate from completing output. Export results capture `{exportSettings:{media,options}}` together with the image. The GUI remembers these options only after its save adapter succeeds. Native cancellation, encoding/write failure, and refused CLI overwrites leave the previous settings intact. The CLI acknowledges after the file write or stdout write callback completes. Browser download dispatch and stdout acceptance cannot prove that a browser download or downstream process ultimately saved its bytes.

Direct `window.openlr.run('export', args)` returns a Blob and captured settings; `dispatch` includes them in its serialized file result. Callers that own output must invoke `export-settings` with the captured value after their own successful save. Preview and `export-hdr` do not carry or update these settings. If output succeeds but persistence fails, GUI and CLI report that the export was saved and remembering settings failed; they do not silently repeat the write. Last successful completion wins, using the captured source-media slot even if selection changes while saving.

`web/export-settings.js` owns normalization and local preference storage. The `export-settings` key holds both slots in one write. Valid legacy `last-export` values supply compatible missing slots; an explicit new slot, including `null` or invalid content, takes precedence. Invalid JSON/options are treated as unavailable without rewriting storage on read. Storage access failures remain visible. This is a local preference, separate from photo recipes and catalog synchronization.

## Verification

```sh
node --test tests/export-settings.test.js tests/export-previous-workflow.test.js tests/agent-cli.test.js
node scripts/native-smoke.mjs /path/to/OpenLR
```

Domain checks cover validation, legacy reads and atomic persistence. Browser tests inspect actual downloaded PNG samples/profile and compare current-asset exports, restart persistence, photo/video isolation and serialized results. Injected native save boundaries exercise cancellation and failures; they are adapter tests, not automated operating-system chooser acceptance. CLI tests inspect real temporary files and stdout completion. The native smoke repeats Original and rendered previous exports through the actual GUI/CLI and checks that a refused overwrite preserves remembered options and original bytes. Platform outcomes are recorded in [acceptance](acceptance.md).
