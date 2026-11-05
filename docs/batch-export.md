# Exporting a selection

Select multiple photos and choose **Export N**, or **Export again**, to write the group into one folder. The active photo, selection, edit histories, preview and video playhead stay unchanged. Single-photo `export` and `export-previous` retain their existing byte-returning contracts.

```sh
node cli/openlr.mjs select-all
node cli/openlr.mjs export-selection --format image/tiff --outputSharpening standard --output-dir ./exports --capture workspace.png
node cli/openlr.mjs export-selection --previous true --output-dir ./exports
```

The destination directory must exist. Omitting `--output-dir` opens the native folder chooser. Optional `--ids '["id1","id2"]'` chooses unique IDs from the current visible view; output still follows display order. Empty, duplicate and unavailable selections fail before writing. `--force` and `--output` do not apply to this command. `--capture` returns the result together with an actual workspace screenshot using the existing CLI capture contract.

## Shared rendering and captured state

The dispatcher captures the selected records, recipes and normalized export options once. Each item uses `web/photo-export.js`, the same preparation owner as single export and preview, with its own decoded source. Batch processing never selects another photo or reuses the active video's playhead. Work is sequential: decode, render, encode, write, release, then advance. Local/referenced originals are read when needed; external modification during export is not an immutable byte snapshot.

Every existing export format retains its constraints. `original` permits mixed photo/video groups. Rendered image output from a video uses its trimmed start frame, or time zero without a trim. Video-container output requires video inputs. DNG preflight reuses the existing DNG/source-type validator; RAW codec failures can still occur during preparation. No incompatible file is silently skipped. Without an explicit format, each media type keeps its ordinary default. `--previous true` resolves photo and video settings independently and cannot be combined with new export options.

Known media/option incompatibilities are checked before output. Runtime read, decode, encode and write errors stop the operation. The response lists completed files with source `id`, `filename`, `path` and `bytes`, plus `total` and `cancelled`. Errors include `details: {completed,total,files,failed}`; completed files remain, the current partial native transfer is removed, and subsequent items are untouched. Cleanup failure is separately reported without hiding the primary error. Cancelling the initial chooser returns `cancelled: true`. There is currently no in-progress batch cancellation or progress polling: the dispatcher remains serialized until the operation finishes. A CLI observation timeout does not cancel native writes.

Both settings slots commit in one storage write only after all output finishes and the folder session closes. Partial failure or chooser cancellation preserves earlier settings. A settings-storage failure reports that output succeeded; files are not retried. Output paths are never remembered.

## Destination adapters

Native GUI and CLI share a folder-scoped adapter and the existing 512 KiB transfer path. Safe basenames retain Unicode; case-insensitive collisions become `name.ext`, `name-2.ext`, etc. Existing files are never implicitly overwritten. Publication refuses a concurrently created exact destination. Filesystems without hard links use exclusive creation and bounded copying; the new file can be visible during this copy, and failure removes it. Temporary output lives beside its destination.

The browser prototype starts `showDirectoryPicker` from the actual GUI submit gesture and waits for each writable stream to close. It does not substitute multiple download dispatches for completed writes. Browsers without directory access report that limitation. The browser API has no exclusive-create primitive: existing names are preserved in ordinary use, but concurrent external creation of the same name is not race-proof. Failed writes abort the stream without deleting a path that might belong to another process; a newly created empty placeholder may remain. Browser paths are directory-name-relative. Browser permission and native OS chooser interaction are distinct from programmatic destination tests.

There is no whole-group archive/base64 array, arbitrary image-size ceiling or new dependency. The current item still needs codec/frame memory. See [research and transport ablation](../research/batch-export.md) and [ADR 015](decisions/015-batch-export.md).

## Verification

`tests/batch-export.test.js` exercises the real browser dispatcher/rendering with an explicitly simulated folder bridge: output parity, mixed processing versions, ordering, GUI export/reuse, mixed-video originals and trimmed-start stills, unchanged state, queued edits, partial errors and atomic settings. `tests/export-folder.test.js` uses actual Chrome filesystem streams for collision/readback/error behavior. Go tests exercise real temporary destinations and publication races. `scripts/native-smoke.mjs` exports a group through the actual CLI into a temporary folder, inspects outputs and captures the workspace. Platform outcomes belong in [acceptance](acceptance.md).
