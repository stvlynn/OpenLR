# Independent delivery review

Reviewed through 2026-11-06 on Windows and WSL Linux. This is delivery evidence, not an overall completeness claim.

## Latest tracked snapshot and public delivery

Commit **`2753c7a2beddfac1b420f384ba0d32656cd6575b`** was exported with `git archive` into new Windows and Linux directories. Both started without `node_modules` or generated CLI resources; no untracked source, optional models, Python packages or prior application builds were copied. External Node 24.9.0/Go 1.27.3 and existing Go caches were explicitly reused.

Both platforms completed fresh `npm ci` (61 packages, zero reported vulnerabilities), Go tests/vet, MyGo packaging and all seven native suites. Linux additionally passed `go test -race ./...` and ran GTK/WebKit under Xvfb/D-Bus. Windows produced the NSIS installer. New source/frame workers are included in this archive and native worker/fallback checks passed. Both native runs explicitly skipped the unavailable independent ExifTool oracle; actual exports/reimports and metadata policy assertions still ran.

Windows default browser verification completed **315 tests: 308 passed, 7 skipped, zero failed**, about 229.1 seconds. The seven skips were sky, depth, denoise/super-resolution, Pillow container extraction, Pillow/Little CMS profile comparison, ExifTool, and independent libpng/LCMS/Python validation. The separately provisioned main-workspace 315/315 result remains distinct. No Linux full-browser-suite run is claimed here.

Both packaged CLIs were copied alone outside their source trees and successfully executed `local-cancel --photoId fixture --dry-run` and dehaze discovery. Parser-backed Windows inspection found one source input and six final external dependencies, all Node builtins. The inspection initially used CJS output mode and then misclassified esbuild's virtual `<runtime>` input marker; ESM output dependencies confirmed that marker is not a runtime import. These were harness corrections, not package changes. Packaged AGPL and third-party notices matched canonical bytes; source notices and distribution assets were present.

Ignored evidence is `.workspace/delivery-2753c7a-*`, the source archive/directory and isolated CLI directory. This renews Windows/Linux tracked-snapshot evidence through `2753c7a`; physical camera, genuine complete external catalogs, OS chooser interaction and final product completeness remain separate boundaries.

On 2026-11-06 the user explicitly changed delivery from private to public. Historical sensitive-file paths and common credential/private-key patterns were checked with no matches, then GitHub confirmed `PUBLIC`/`isPrivate:false`. [OpenLR](https://github.com/stvlynn/OpenLR) retains AGPL-3.0-only and its provenance/notices. This bounded review does not guarantee detection of every possible secret pattern. Earlier private-delivery requirements and checks below are historical. The preceding private CI run `42064995779` had zero steps and a macOS account-payment/spending-limit annotation; public visibility alone does not establish passing CI.

### Public Actions verification

The repair-source application commit **`a05a501`** passed [run 42080915924](https://github.com/stvlynn/OpenLR/actions/runs/42080915924) on its first attempt: all three platform packages and seven-group native suites completed successfully. Windows browser verification passed 309/317 with eight optional-resource skips and no failures; its native log explicitly includes source/picker state, selected-photo guard, cancellation, PNG capture and unchanged-recipe checks. This is remote acceptance of `a05a501`, distinct from later creation-completion parity changes.

The subsequent application commit **`38f35af`**, adding live straighten-reference state and cancellation, passed [run 42073613235](https://github.com/stvlynn/OpenLR/actions/runs/42073613235) on all three platforms. Windows, Linux and macOS Intel each built and passed all seven native suites, including the new guarded straighten session; artifacts uploaded successfully. Windows browser tests passed 308/316 with eight optional-resource skips on a failed-job-only retry. The first attempt's video-import bitmap failure, local isolated 4/4 pass and 125 successful direct-poster probes are retained in the [investigation](../research/video-poster-failure.md). No code, assertion or timeout changed for the retry, and the root cause remains unproven. This renews remote acceptance through `38f35af`; the clean local archive results below/above retain their original revisions.

[Run 42067429068](https://github.com/stvlynn/OpenLR/actions/runs/42067429068), at documentation commit `a14a9fb` with application source unchanged from `2753c7a`, completed successfully on Windows, Ubuntu 24.04 and macOS 15 Intel. Each platform built its native distribution, passed all seven native suites and uploaded application/verification artifacts. Linux also passed Go race tests. The macOS universal package was executed on Intel; Apple Silicon execution is not established by this run.

The first Windows attempt failed at the initial PNG download wait in the processing-2 color workflow (`tests/color-workflow.test.js`): 306 passed, one failed, eight skipped. An isolated local rerun passed all three color-workflow tests. Only the failed Windows job was then retried, with no code or timeout changes: 307 passed, zero failed and eight skipped out of 315 browser tests, followed by successful packaging and all native suites. The original timeout remains unexplained; retry success is not evidence of a root-cause fix. Optional-resource skips and synthetic camera/catalog/chooser boundaries remain explicit in the logs. Ignored evidence includes `.workspace/public-actions-42067429068-*` and downloaded platform verification artifacts.

## Earlier tracked-snapshot reproduction

Commit **`afbdcb8348d0e26de1775d3c308ab3bc5c91ff17`** was exported using `git archive --format=tar`, then extracted into a newly created ignored directory. Before installation, neither `node_modules` nor generated `resources/cli/openlr.mjs` existed there. No untracked application files, downloaded optional model weights, ExifTool checkout, Python CMS packages or prior build output were copied into that snapshot.

The explicitly selected external Go 1.27.3 toolchain used existing Go module/build caches, and Node 24.9.0/Chrome 156 were installed host prerequisites. This is not an offline or empty-toolchain-cache reproduction. From the snapshot, the following commands actually completed:

| Check | Result |
| --- | --- |
| `npm ci` | 61 packages installed from the committed lockfile; npm reported zero vulnerabilities at that run. |
| `go test ./...` | Root and independent review-service tests passed; command/fixture packages had no tests. |
| `go vet ./...` | Exit zero. |
| `node scripts/desktop.mjs build -platform windows/amd64 -o build/release` | MyGo built the application, generated the bundled CLI/resources and created the NSIS installer. |
| `npm test` with default optional-tool settings | 311 total: **304 passed, 7 skipped, 0 failed**. No skip is counted as success. |
| `node scripts/native-suite.mjs build/release/windows-amd64/OpenLR.exe` | All seven native groups passed using the newly built application and helper binaries built from the snapshot. |

The seven default-suite skips were sky segmentation, depth inference, denoise/super-resolution, independent Pillow container extraction, Pillow/Little CMS profile comparison, ExifTool metadata readback, and the independent libpng/gamma/chromaticity check. Their optional local resources were absent. The separate native LCMS float-input test did run using the installed host environment. Native metadata paths still checked output files, but the optional ExifTool oracle was not provisioned for this snapshot. Earlier fully provisioned test runs retain their own revision/environment scope; they do not convert these skips into passes.

The snapshot's native suite verified real GUI/CLI transport, current dehaze workers, viewport scrolling/capture, DNG and high-depth processing, sidecar reopen, synthetic migration, a launched external-editor fixture, simulated camera capture, actual loopback review publication/comments/likes/revocation, panorama/HDR, CRW-to-linear-DNG and bundled subject/person inference. These remain the existing bounded contracts: no physical camera, genuine complete external catalog, native chooser interaction or public hosting was established.

The generated package's `cli/openlr.mjs` was copied alone into another directory without an adjacent `web/` or `node_modules`. It successfully ran `viewport --x 50 --dry-run` and `cli search "color grading"`. Parsing/rebundling that isolated file with installed esbuild found exactly one input and six external imports, all Node builtins. An initial regex import scan incorrectly matched ordinary strings containing “import”; its assertion was discarded and replaced by the parser-backed check. This check and actual execution establish the tested standalone discovery path, not every hypothetical dynamic branch.

The packaged AGPL text and `THIRD_PARTY_NOTICES.md` matched their canonical source files byte for byte. The native package also contained `SOURCE.md`, component license directory, CLI, icon, application and installer. No new digest requirement or runtime gate was introduced. Ignored evidence lives under `.workspace/delivery-afbdcb8*` and `.workspace/cli-isolated-afbdcb8/` on the tested machine.

This closes the Windows clean tracked-snapshot reproduction gap through `afbdcb8`. It is not byte-for-byte binary reproducibility, a Linux clean-snapshot run, current macOS acceptance, code signing/notarization or proof of full product/interaction coverage. Later implementation changes require corresponding renewed verification; documentation-only recording does not alter the tested application.

## Linux tracked-snapshot reproduction

The same `afbdcb8348d0e26de1775d3c308ab3bc5c91ff17` archive was subsequently extracted into a new persistent WSL Linux directory, without copying Windows `node_modules`, an earlier Linux build or optional test resources. With the installed Linux Node 24.9.0 and Go 1.27.3 toolchain, and explicitly reused Go module/build caches, `npm ci`, `go test ./...`, **`go test -race ./...`**, `go vet ./...` and MyGo Linux/amd64 packaging all exited zero. The build produced the application, Debian package, tar archive, desktop integration files, notices and bundled CLI.

`xvfb-run -a dbus-run-session -- node scripts/native-suite.mjs build/release/linux-amd64/openlr` then passed all seven groups against that newly built application on Ubuntu 24.04/WebKitGTK 2.52.6. The host's Chrome was used for the independent review visitor. ExifTool was absent and its optional native oracle was explicitly skipped; actual format/metadata export and reimport assertions still ran. No Linux full-browser-suite run is claimed by this increment. Xvfb and Mesa/EGL diagnostics do not establish physical GPU/display behavior.

Linux packaged license and notice files matched canonical source bytes using `cmp`. The packaged CLI was copied alone to a new sibling directory outside the source tree, then successfully executed `viewport --x 50 --dry-run` and color-grading command discovery. No additional runtime JavaScript files were copied. The ignored Windows-side capture is `.workspace/delivery-afbdcb8-linux.log`.

Together these runs provide Windows and Linux clean tracked-snapshot delivery evidence through `afbdcb8`, superseding the Linux exclusion in the preceding historical paragraph. They do not establish current macOS acceptance: the latest inspected [CI run 42052317375](https://github.com/stvlynn/OpenLR/actions/runs/42052317375), for documentation-only `6d8ecd4`, completed with zero steps on all three platforms; the macOS check annotation explicitly reported failed account payments or a spending-limit issue. No job execution is counted as having occurred. Full interaction coverage, physical-device boundaries and remaining large-image latency still belong to the completion audit.

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
