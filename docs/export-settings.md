# Reusing export settings

**Export again** and Ctrl/Command-E export the active photo or video with its last completed settings, or the selected group when more than one item is selected. Group output uses the [batch export](batch-export.md) folder workflow. The native File menu's **Export with previous settings** and `export-previous` command use the same operation. Without usable settings, the GUI opens Export; the CLI reports `Choose export settings first`. Ordinary Export restores the last completed options, so cancelling a draft does not change the next export.

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

On 2026-11-06 the Windows/amd64 WebView2 `precise-controls` package, built from the combined source recorded as `cb64646`, exercised the actual operating-system Save dialog in an isolated session. The GUI started with remembered PNG, sRGB and a 32-pixel long edge. Changing the long edge to 16 and pressing Escape in the native Save dialog left the destination empty and the remembered size at 32. Reopening Export visibly restored 32. Setting 16 again and accepting the native Save dialog wrote a 115-byte PNG and committed 16 as the remembered size.

The verifier decoded the saved image as 16×12 and checked all pixels against RGBA `[64,96,128,255]`. The imported original and the source on disk both matched the generated 93-byte PNG. Selection and photo state stayed the same, and the isolated host closed normally. The cancel and save reports are under ignored `.workspace/native-save-live/run-QwdwnV/`. This observation covers the Windows single-photo Save dialog on that package.

On 2026-11-07 the archived Linux distribution under `.workspace/linux-native-final/` exercised the actual GTK Save dialog on WSL Ubuntu 24.04 with GTK 3.24.41 and WebKitGTK 2.52.6. Changing the remembered PNG long edge from 32 to 16 and pressing Escape left the destination empty and kept 32. Reopening Export showed 32. Confirming the next Save wrote a 112-byte PNG at 16×12 and remembered 16. Independent decoding checked every pixel against `[64,96,128,255]`. The imported original and the generated file matched all 93 bytes, selection stayed unchanged and cleanup completed. The archive's single-photo save and remember branch matches current source. The archive predates some transfer and settings helper changes, and its source directory label does not attest an exact revision. This run covers isolated GTK/X11 with the portal disabled. Wayland, desktop Portal and macOS dialog behavior remain separate. The log and captures are in `.workspace/native-save-linux-verified.log` and `.workspace/native-save-linux/`.

The hosted `dad42fe` Linux package also repeated cancellation and save with the real GTK Portal on a private Xvfb display and D-Bus session. The bus recorded both `SaveFile` calls through the Portal frontend and GTK backend. Cancel kept the previous 32-pixel option and wrote no file. Confirm wrote the 112-byte 16×12 PNG, every pixel matched `[64,96,128,255]`, and the original remained 93 identical bytes. The successful request returned the actual output file URI. The Documents FUSE mount was unavailable in this isolated session. [Portal test environment](local-folders.md#verification) · [Package run](https://github.com/stvlynn/OpenLR/actions/runs/42289203264)

The same package verified Save on a private headless Wayland session with no X11 display. The CLI set the PNG and 32-pixel options. AT-SPI opened the app's Export form and both native Portal dialogs, canceled one and confirmed the absolute destination in the other. The two requests reached the Portal frontend and GTK backend. Cancel preserved the options and wrote no file. Confirm wrote a 133-byte 32×24 PNG, every pixel matched `[64,96,128,255]`, and the current selection and 93 original bytes were preserved. WebKit exposed the numeric field's value through accessibility in this environment, so the run used the CLI to set it. The Wayland parent-window association and FUSE limits are shared with the folder chooser test. [Wayland environment](local-folders.md#verification)

The `8a76636` Debian payload repeated both Save actions on the headless Sway session with `xdg_foreign`. The protocol trace matched the Portal parent handle to GTK's import and `set_parent_of` call for each Save dialog. Cancellation preserved the remembered options and wrote no file. Confirmation reproduced the 32×24 PNG and preserved the 93 source bytes and the current selection. Logs are under `.workspace/native-save-linux-wayland-parent-trace/`. The FUSE-backed Documents Portal was unavailable in this isolated session. [Wayland environment](local-folders.md#verification)

A fresh Linux package built from the exact `e365a88` archive also passed the GTK Save workflow in the same isolated environment. Cancellation kept 32 and wrote no file. Confirmation saved the 112-byte 16×12 PNG and remembered 16. The output pixels, original bytes and cleanup passed again. The log is `.workspace/native-save-linux-e365a88.log`. [Exact package evidence](delivery-review.md#linux-tracked-snapshot-e365a88)

On Intel and Apple Silicon macOS, the native File menu's **Export with previous settings** opened a real Save sheet for the remembered Original format. System Events canceled one sheet without writing a file and accepted another in the specified folder. The saved PNG matched all 93 source bytes. [Hosted panel results](https://github.com/stvlynn/OpenLR/actions/runs/42307168350)
