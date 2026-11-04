# Local folders

The desktop **Storage → Open local folder…** action opens the operating system's directory chooser. Selecting a directory grants OpenLR access to that root and its descendants. Recent authorized roots are remembered in the current user's `OpenLR/folders.json`; `OPENLR_LOCAL_FILE` selects a separate registry for tests. The root path and folder names stay on the local machine.

Local mode lists filenames and metadata without importing the original files into IndexedDB. Thumbnails are decoded as they enter the viewport; editing and export load the selected original through a read-only MyGo protocol. The imported **Photo library** remains a separate workspace. A refresh/reopen rereads the folder, so externally added or removed files are reflected. Folder symlinks are not listed, and Go `os.Root` prevents a relative path or image symlink from escaping the authorized root.

Edits, rating, flags, keywords and named versions are saved to **`<image filename>.openlr.json` beside the original**. Sidecars are replaced only after the new JSON is written. The original image is never modified by an edit. Moving a photo to another machine should include its OpenLR sidecar. These sidecars are OpenLR JSON, not Adobe XMP interoperability. An unreadable or unsupported sidecar is reported and cannot be silently overwritten by the editing adapter. A read-only/disconnected folder produces a visible save/read error.

Global albums belong to the imported library; Local mode does not add disk references to those albums. Local delete/restore updates the sidecar's reversible visibility flag and does not remove files from disk. JPEG/PNG/TIFF and camera RAW support use the same decoder, renderer and export pipeline as the library; an extension being listed does not guarantee its particular codec variant is supported.

```sh
node cli/openlr.mjs local-open
node cli/openlr.mjs local-folders
node cli/openlr.mjs local-open --root <authorized-root-id>
node cli/openlr.mjs local-browse --relative subfolder
node cli/openlr.mjs edit --key Exposure --value 0.5
node cli/openlr.mjs export --format image/png --output edited.png
node cli/openlr.mjs library
```

The first command uses the real desktop chooser. CLI paths do not automatically grant new filesystem access. Subsequent commands operate on the current native GUI and the already authorized root.

Verification: `go test ./...` covers authorization persistence, sidecar overwrite/reopen, unchanged source bytes, protocol bytes and traversal rejection. `node --test tests/local.test.js` uses a real browser with a mock native boundary to verify image export and zero original entries in IndexedDB. `node scripts/native-local-smoke.mjs <executable>` verifies a generated DNG folder, native streaming, sidecars, export and process restart. This test grants only its fixture folder through a test registry. The real system chooser was compiled and displayed, but its automated interaction was blocked by a Computer Use app-approval timeout; it is not reported as an interactive pass.
