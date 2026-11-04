# Independent delivery review

Reviewed 2026-11-05 on Windows with Node 24.9.0, Go 1.27.3 and WebView2. This review does not push changes or set the overall project goal status.

## Reproduction evidence

An archive of tracked commit **`6aa4628`** was expanded into an independent ignored directory, without `node_modules`, workspace caches, generated CLI output or other untracked assets. From that source tree, `npm ci` succeeded against the committed lockfile; the single-file CLI built and returned command schemas; `go test ./...`, the independent share-server build, and the MyGo Windows package build succeeded. The resulting package then passed the real native DNG/edit/CLI/observe/screenshot/person-model/TIFF/WebDAV smoke test.

The bundled CLI was also copied out of the project tree and successfully executed offline schema discovery with only Node. Its generated file imports Node builtins and does not require an adjacent `web/` tree. The standalone `openlr-share` executable was built separately; browser gallery, comments, likes, native readback, authorization and revocation were tested on loopback. A later actual reverse-proxy test mounted it under `/proof`, verifying that browser fetches and image links retain the deployment prefix.

This is functional reproducibility, not a claim of byte-for-byte deterministic binaries. Later working-tree changes, including new migration/enhancement modules, must be included in the final commit before a new clean-checkout claim. Static production-import inspection identified those pending files rather than treating their presence in the working directory as proof that Git contains them.

## Fixed findings

- **Administrator-token exposure:** CLI dry-run output redacted passwords but printed the new sharing token. It now redacts token/secret/password argument fields; a CLI test verifies the sharing case.
- **Missing distribution notices:** MyGo packages contained dependency notices but omitted the project AGPL text, consolidated provenance inventory and source entry point. The build now generates these resources from the canonical root files; their actual presence was checked in the rebuilt package.
- **Review-server failure semantics:** A failed JSON commit could leave an unsaved comment visible in memory and duplicate it on a retry. Failed commits now restore the last committed snapshot, with an injected filesystem-failure test.
- **Duplicate agent reply:** After HTTP consumed the first reply but before its response finished, a second reply could be accepted. The pending command is now claimed under the mutex; a focused test consumes the first reply before attempting the second.
- **Reclaimed media references:** A Blob cached in one tab could retain a chunk key after another tab/sync removed its owners. The write transaction checks reused references atomically and repacks from the still-valid Blob when needed. The 140 MiB storage test covers this case in addition to rollback, reuse and legacy reads.
- **Mounted review viewer:** Absolute root paths broke a reverse proxy deployment below a path prefix. The viewer now derives its album and API prefix from the actual URL; the browser acceptance test verifies the mounted deployment.

## Asset and license observations

Fifty-three pinned runtime assets from the codec, OpenCV, SQLite, ONNX and bundled-model manifests matched their recorded SHA-256 digests. Runtime notices, LibRaw source archives, the two bundled small segmentation weights and their original licenses were present in the tracked source snapshot. The SQLite wrapper's retained MIT/AUTHORS/Emscripten materials were also added to the consolidated inventory. The new review page links to the actual OpenLR source repository and states the project license.

This is a concrete inventory/source check of the reviewed artifacts, not a declaration that every possible future dependency or distribution is covered. Optional downloaded models remain governed by their recorded individual terms. Their weights are not silently included as copies of catalog originals.

## Verification and boundaries

The current native package passed DNG editing/original preservation, Local sidecars and reopen, a real controlled external-editor process, explicitly labeled camera-simulator capture, loopback review publication, panorama/HDR, real CRW-to-linear-DNG conversion, two bundled AI models and workspace capture. The later migration smoke passed only synthetic Classic-schema and exported-resource fixtures, authorized references, missing-file retry and original preservation. It did not validate a real Adobe catalog or PhotoKit library.

`go test ./...` and `go vet ./...` passed after the Go fixes. The catalog/CLI/Local/organization/sync browser set passed, including the 140 MiB + 17-byte stress fixture. Linux CI now includes `go test -race ./...`; that newly added race step was not run locally because this Windows environment has no C compiler. The existing matrix covers Windows, Ubuntu/WebKitGTK and macOS Intel; a successful compile is not substituted for an actual runtime result.

The real directory-picker interaction remains unverified because Computer Use app approval timed out. Physical camera capture remains unverified: WIA discovery found no still camera and gphoto2 was unavailable. All review/camera/editor tests used generated or explicitly licensed fixtures, with no public deployment or private-photo upload.
