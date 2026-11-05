# External editor roundtrip

Select a photo, choose an installed editor with **Choose external editor…**, then use **Edit copy externally**. **Use Photoshop** detects an installed Photoshop executable/application in the standard Windows/macOS locations. The same actions are in the desktop File menu. OpenLR exports the current rendered edits to an independent TIFF, launches the chosen application without a shell, and preserves the source photo and its edit recipe.

Save that TIFF in the external editor using its normal Save action. OpenLR waits for the file's size and timestamp to stabilize, hashes the contents, snapshots the saved revision, and imports it as a new **Photo library** photo. Returned copies have `derivedFrom`, `externalSession` and `externalRevision` metadata; they start with an empty edit recipe because the TIFF already contains the rendered edits. Local-folder originals stay in place; an externally edited derivative is intentionally added to the imported library.

The editor process may exit immediately after forwarding the file to an existing application instance, so process exit is not treated as evidence of a save. A later save is detected by the file itself. Immutable snapshots prevent a second editor save from changing bytes during an import. An acknowledged revision is not imported twice. Pending sessions are persisted and can be checked after restarting OpenLR.

```sh
node cli/openlr.mjs external-editor
node cli/openlr.mjs external-editor --photoshop true
node cli/openlr.mjs external-edit
node cli/openlr.mjs external-check
```

The GUI also checks pending copies automatically. The configured executable and session records live in the user's `OpenLR/external.json`; generated copies are in its `external-edits/` directory. `OPENLR_EXTERNAL_FILE` and `OPENLR_EXTERNAL_EDITOR` are test/deployment overrides. Generated files are retained for recovery. Saving under a different filename with Save As is outside the watched-file contract; save the handed-off TIFF to return it. Read, decode, launch and write failures are reported, and a failed import leaves its saved copy available.

The handoff uses the shared rendered TIFF export: Original processing writes 8-bit samples and Linear processing writes 16-bit samples. Saved copies return through the existing TIFF importer. Precision preservation by every external editor, layered PSD roundtrips, and every TIFF compression/layout variant remain outside the verified scope.

`go test ./...` verifies persisted immutable snapshots and acknowledgment. For a real process/file test, build the controlled editor and run:

```sh
go build -o .tools/test-editor.exe ./scripts/fixtures/editor
node scripts/native-external-smoke.mjs <OpenLR executable> .tools/test-editor.exe
```

That test uses a generated DNG, applies an edit, exports TIFF, launches an actual local process that modifies and rewrites the TIFF twice, imports the saved derivative, checks deduplication and confirms the original bytes remain unchanged. It passed on Windows/WebView2. Photoshop itself was not used in this controlled process test.
