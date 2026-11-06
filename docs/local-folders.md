# Local folders

The desktop **Local → Open folder…** action opens the operating system's directory chooser. Selecting a directory grants OpenLR access to that root and its descendants. Recent authorized roots are remembered in the current user's `OpenLR/folders.json`; `OPENLR_LOCAL_FILE` selects a separate registry for tests. The root path and folder names stay on the local machine.

Local mode lists filenames and metadata without importing the original files into IndexedDB. Thumbnails are decoded as they enter the viewport; editing and export load the selected original through a read-only MyGo protocol. The imported **Photo library** remains a separate workspace. A refresh/reopen rereads the folder, so externally added or removed files are reflected. Folder symlinks are not listed, and Go `os.Root` prevents a relative path or image symlink from escaping the authorized root.

Edits, rating, flags, keywords and named versions are saved to **`<image filename>.openlr.json` beside the original**. Sidecars are replaced only after the new JSON is written. The original image is never modified by an edit. Moving a photo to another machine should include its OpenLR sidecar. These sidecars are OpenLR JSON, not Adobe XMP interoperability. An unreadable or unsupported sidecar is reported and cannot be silently overwritten by the editing adapter. A read-only/disconnected folder produces a visible save/read error.

The folder listing reports `sidecarPresent` separately from its recipe: a photograph without a sidecar and a historical sidecar containing an empty recipe both retain legacy processing, and remain distinguishable. An absent `edit.processVersion` means process 1. Explicit process 1 and 2 values are preserved along with metadata and each named version's own recipe; other process versions are rejected on read and save. The sidecar envelope uses `version: 2` when either the current edit or a named version uses process 2, so older clients that accept only envelope 1 report an unsupported sidecar instead of rendering the recipe with legacy rules. Envelope 1 cannot contain a process-2 recipe. Valid legacy sidecars continue to use envelope 1. Direct native save calls also refuse to replace an existing unreadable or unsupported sidecar.

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

Verification: `go test ./...` covers authorization persistence, sidecar presence, process-version envelope selection and rejection, sidecar overwrite/reopen, unchanged source bytes, protocol bytes and traversal rejection. `node --test tests/local.test.js` uses a real browser with a mock native boundary to verify image export, zero original entries in IndexedDB, version and metadata preservation, and adapter rejection of unsupported current/saved recipes. `node scripts/native-local-smoke.mjs <executable>` exercises a generated DNG folder through native GUI/CLI state: process-2 opt-in, metadata and named-version persistence, envelope protection, version-preserving reset/undo, independently decoded TIFF16 samples, restart/reopen, unchanged historical empty sidecars, rejected unsupported sidecars, and original-byte preservation. This test grants only its fixture folder through a test registry. Run it against each supported operating system's actual built executable; passing the Windows run does not establish macOS/Linux behavior.

On 2026-11-06 the actual Windows chooser was operated through Computer Use against the `cb64646` media working-tree package, using an empty ephemeral catalog and separate authorization registry. Canceling the first dialog left `local-folders` empty and the catalog at zero photos. The next dialog selected only the generated fixture directory. The GUI displayed `generated.png`; the shared CLI reported one authorized root and one photo. Independent PNG decoding of its preview read 32×24 pixels with RGBA `[64,96,128,255]`, and original export matched all 93 source bytes. The temporary host closed normally and the generated source remained unchanged. This supersedes the earlier app-approval timeout for this Windows interaction; macOS/Linux chooser interaction remains separate. Ignored evidence is `.workspace/native-chooser-live.mjs`, `.workspace/native-chooser-verify.mjs` and `.workspace/native-chooser-live/`.
