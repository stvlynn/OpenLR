# Local image codecs

`web/formats.js` owns the export format contract used by the GUI, CLI schema, filename generation and codec adapter. Existing order is preserved: JPEG, PNG, Original, followed by TIFF, AVIF and JPEG XL. Originals return their existing bytes and filename. Re-encoded formats use `.jpg`, `.png`, `.tif`, `.avif` or `.jxl` and the matching MIME type. The application supplies the rendered canvas after crop, adjustments and optional export watermark/resize. The [output color adapter](export-color.md) converts samples to the requested space and embeds matching profiles for supported formats.

## Format behavior

| Format | Import | Export | Quality |
| --- | --- | --- | --- |
| JPEG / PNG | Native browser image codec | Native encoding for sRGB; converted samples with ICC for other named spaces (explicit PNG encoder, native JPEG compression) | JPEG 0–1; PNG has no quality control |
| TIFF | UTIF, first image, orientation applied; RGB ICC uses native CMS via tagged PNG | Dynamic uncompressed 8-bit RGBA TIFF with unassociated alpha and ICC | Not exposed |
| AVIF | Bundled jSquash/libavif decoder | Bundled jSquash/libavif encoder, 8-bit output | 0–1; exactly 1 selects the codec's true lossless mode |
| JPEG XL | Bundled jSquash/libjxl decoder, independent of browser JXL support | Bundled jSquash/libjxl encoder, 8-bit output | 0–1; exactly 1 selects true lossless mode |
| Camera RAW/DNG | LibRaw adapter | Original bytes or a rendered raster format | See [RAW decoding](raw-decoding.md) |

The shared input accept list includes TIFF/AVIF/JXL extensions, and the CLI gives imported files the corresponding MIME type. `decodePhoto` is shared by import, original reload and export source loading; filenames do not get relabeled without actual encoding. TIFF's unassociated-alpha tag matches `ImageData`; imported associated-alpha samples are unpremultiplied before becoming a bitmap. TIFF floating point, unsupported layouts and sensor DNG disguised as TIFF are rejected visibly rather than silently rendered as zeroes. A `.dng` source goes through LibRaw.

All rendered exports use the current 8-bit canvas pipeline. They do not preserve arbitrary original EXIF/ICC/animation/multiple-page structure or create a high-bit-depth RAW master. Named target profiles are generated independently. TIFF exports normally use classic TIFF, with BigTIFF layout for offsets beyond 32 bits; multi-gigabyte allocation/interoperability is untested and the importer accepts classic TIFF only. TIFF import takes the first supported image rather than creating a page sequence. Generic unprofiled CMYK conversion is not an ICC-managed print workflow; incompatible embedded color-profile layouts are rejected. AVIF/JXL use the packaged codec versions and currently output sRGB only. Original export remains the path for preserving original compressed bytes and metadata.

## Worker lifecycle and native compatibility

`web/raw-kernel.js` and `web/codec-kernel.js` own the implementations. The Worker files are thin message/transfer adapters. `web/image-worker.js` serializes heavy codec jobs and terminates each normal Worker after success or failure, releasing its WASM heap. An explicit startup handshake happens **before** transferring an encoder's pixel buffer.

Some native custom-scheme hosts cannot construct/load module Workers. If construction throws, or the Worker module fails before the handshake, the runner terminates it and dynamically imports the exact same kernel on the main thread. It does not invent a second decoder, retry processed corrupt inputs, or convert runtime decode failures into success. Normal browser hosts keep the isolated path. `main.go` registers `.js` / `.mjs` as JavaScript and `.wasm` as WebAssembly independent of OS file associations.

Fallback creates a console diagnostic and an entry in `state.codecDiagnostics`, also accessible through `getImageWorkerDiagnostics()`. Records include the Worker module name, startup phase, fallback route and error message; photo filenames/contents are not recorded. The list retains 20 entries. Main-thread fallback can block the UI and retain a reusable WASM high-water heap despite per-photo disposal; the two-minute Worker cancellation boundary cannot interrupt synchronous main-thread WASM execution. This compatibility path is a tested fallback, not a claim of identical memory isolation.

## Packages and build provenance

| Component | Fixed version/revision | Terms and retained materials |
| --- | --- | --- |
| UTIF.js | npm `utif` 3.1.0, git `27f1098a67c3cfd4348c9b8fd887fcd8cd171095` | MIT, copyright 2017 Photopea; `web/vendor/codecs/LICENSE.UTIF` |
| pako | npm 1.0.11 | MIT wrapper and zlib-port notices in `LICENSE.pako` / `NOTICE.pako-zlib` |
| jSquash AVIF | npm `@jsquash/avif` 2.1.1, git `b7fa9ac9ec02f224847ad23d19d115f9e296a368` | Apache-2.0, Google / Jamie Sinclair notices in modules and `avif/LICENSE` |
| jSquash JPEG XL | npm `@jsquash/jxl` 1.3.0, git `1b1964194611ece3ec984ab91c04726d1088f05e` | Apache-2.0, Google / Jamie Sinclair notices in modules and `jxl/LICENSE` |
| wasm-feature-detect | npm 1.9.0, transitive locked dependency | Apache-2.0, `LICENSE.wasm-feature-detect` |

`scripts/vendor-codecs.mjs` copies the published JS/WASM with these adaptations only: wraps UTIF and pako's unchanged CommonJS/UMD bodies in ESM adapters, and changes jSquash encoder imports of wasm-feature-detect to local relative modules. Each changed encoder carries a modification notice. WASM files remain byte-identical to the installed npm packages. `manifest.json` records every runtime asset's size and SHA-256; `package-lock.json` records tarball integrity. No frontend bundler or runtime CDN is required. All files under `web/` are embedded in the native application.

The jSquash build files identify AVIF's compiled sources as libavif 1.0.1, libaom 3.7.0 and libwebp/sharpyuv `e2c85878f6a33f29948b43d3492d9cdaf801aa54`; JPEG XL uses libjxl `9f544641ec83f6abd9da598bdd08178ee8a003e0` and its fixed Brotli, Highway and skcms gitlinks. Their licenses, authors and applicable patent grants are retained in `web/vendor/codecs/notices/`, with exact source URLs and hashes in `notices/sources.json`. Emscripten's license is retained there too. The codecs were taken from the published packages, not independently rebuilt from C/C++ during this change; the source revisions come from upstream build inputs. This provenance does not assert byte-for-byte reproducibility.

Rebuild vendored JS/assets using `npm ci` then `npm run build:codecs`. Existing reviewed component notices remain beside them. `node scripts/fetch-codec-notices.mjs` refreshes the pinned notice files using network access; it is deliberately separate from ordinary offline codec builds. Preserve all these notices and the separate LibRaw corresponding-source archives when distributing the native bundle.

## Checks

Run `node --test tests/codecs.test.js tests/worker-fallback.test.js tests/raw.test.js` with installed Chrome and a reachable local HTTP server. On Windows/Chrome, generated 32×24 RGBA gradients round-trip losslessly through TIFF/AVIF/JXL with measured maximum channel difference **0**. The current writer emits classic TIFF `II 2A 00` (the previous writer emitted `MM 00 2A`), AVIF `ftyp`/`avif`, and JXL `FF 0A` signatures. Tests also verify lossy quality, corrupt-input rejection, GUI import/export and quality visibility, exact extensions, TIFF Deflate/orientation/associated alpha, and both normal and cross-origin-isolated threaded encoders. Forced Worker constructor failures and real 404 Worker-module loads still decode DNG and round-trip all three raster formats through shared kernels; processed corrupt RAW does not trigger compatibility fallback. Physical-camera files, arbitrary TIFF encodings, animation, other operating systems/WebViews and huge images need further coverage.

Sources: [UTIF API](https://github.com/photopea/UTIF.js/tree/27f1098a67c3cfd4348c9b8fd887fcd8cd171095), [jSquash AVIF](https://github.com/jamsinclair/jSquash/tree/b7fa9ac9ec02f224847ad23d19d115f9e296a368/packages/avif), [jSquash JPEG XL](https://github.com/jamsinclair/jSquash/tree/1b1964194611ece3ec984ab91c04726d1088f05e/packages/jxl). Context7 `/jamsinclair/jsquash` was consulted for Worker and manual-initialization API documentation.
