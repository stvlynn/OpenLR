# RAW decoding

`web/decode.js` is the codec adapter. `decodePhoto(file)` returns an owned `ImageBitmap`; its caller closes it after use. Import, reopening a stored original, preview, and export use this boundary. Browser-supported raster images use `createImageBitmap`; camera RAW extensions use the bundled LibRaw WebAssembly decoder. No cloud service, camera software, or Adobe binary is required.

## Processing and preservation

The internal `decodePhotoFrame` working-purpose API separately retains 16-bit wide LibRaw samples in a signed linear Float32 frame. It is implemented and tested through float rendering and TIFF16 output, but is not yet selected by application recipes. Its exact matrix, source clipping limits and pending migration are documented in [linear working frames](linear-working-frames.md). The ordinary application behavior below remains unchanged.

The RAW base is full-size, oriented using the camera metadata, camera white balanced, demosaiced, and decoded as 16-bit linear sRGB by LibRaw, then explicitly encoded to an 8-bit standard sRGB bitmap by the shared color adapter. Both normal and linear-frame decoding explicitly set unit gamma; auto brightness is disabled and brightness is one. LibRaw's default BT.709 transfer is not used as though it were standard sRGB. The adapter adds no exposure, HSL, crop, sharpening, or other application edit. `render.js` owns application edits for previews and exports.

The original immutable `File` remains in IndexedDB. A decoded bitmap is a display/export base, **not** the original sensor data and not a lossless high-bit-depth editing buffer. Original RAW sensor precision, camera metadata, and all compressed bytes remain in the stored source. Rendered exports have the current canvas pipeline's 8-bit limits. The extra precision is retained only for callers explicitly requesting the linear frame, such as DNG and HDR. Normal decoding allocates 16-bit processed source samples plus an 8-bit RGBA display buffer; it does not allocate the optional Float32 RGB frame. LibRaw rendering is not Adobe rendering, and color-managed monitor/HDR output is outside this adapter.

RAW work runs in one module Worker per file. Work is serialized to avoid overlapping large WASM heaps. `dispose()` releases decoder/input allocations; terminating the Worker after either success or failure releases the whole WASM high-water allocation. Pixel results move to the caller as a transferred `ImageBitmap`, without copying a second full bitmap to the main thread. A later decode after failure creates a new clean Worker.

`raw-kernel.js` is also the single implementation used by the native compatibility path: if a module Worker fails before its startup handshake, the shared image-worker runner dynamically imports that kernel on the main thread. Normal processed decode failures are not retried. This path keeps original bytes intact and per-photo disposal, but can block the UI and retain a reusable WASM heap. Worker startup diagnostics appear in `state.codecDiagnostics`. See [image codecs](image-codecs.md) for the common lifecycle and tested failure scenarios.

The pinned binary initializes a 17,563,648-byte heap (measured through `HEAPU8.byteLength`); its generated runtime caps heap growth at 2,147,483,648 bytes. This is only the WASM address-space allowance: source buffers, owned RGB copies, RGBA pixels, and browser bitmaps additionally use host memory. Worker termination avoids retaining the enlarged WASM heap between assets.

There is no application-imposed file-size or megapixel ceiling. Browser/WASM memory and allocation limits still apply, and each RAW decode has a two-minute timeout. Allocation failures and unsupported compression are reported as visible import failures. The original is never overwritten. The bitmap cache and selection/revision cancellation belong to the application layer.

## Versions, provenance, and distribution

- `@colorhythm/libraw-wasm` **1.1.1**, npm gitHead [`9b0f59a5e0f6d3d12a8f6fa594015ef4f30a6e95`](https://github.com/colorhythm/libraw-wasm/tree/9b0f59a5e0f6d3d12a8f6fa594015ef4f30a6e95). MIT wrapper, copyright TOMIKAWA Sotaro. npm integrity is in `package-lock.json`.
- Runtime version query reports LibRaw **0.22.1-Release**, 1,274 camera names. The wrapper's exact LibRaw gitlink is [`b860248a89d9082b8e0a1e202e516f46af9adb29`](https://github.com/LibRaw/LibRaw/tree/b860248a89d9082b8e0a1e202e516f46af9adb29). Camera inventory is not proof every RAW compression variation works.
- `typed-cstruct` **0.10.2**, MIT, copyright TOMIKAWA Sotaro.
- The wrapper build workflow pins Emscripten **4.0.8**. Its build script removes zlib linkage and enables X3F; this binary has no external JPEG/LCMS/DNG SDK integration. Deflate/lossy/JPEG XL DNG and other optional codecs can be unavailable. Ordinary uncompressed DNG is tested. Standard lossless JPEG code is part of LibRaw, but no camera-wide format guarantee is made.

`node scripts/vendor-raw.mjs` copies modules, WASM, and package licenses from `npm ci`. It changes only two bare `typed-cstruct` import specifiers to local module paths. The WASM stays byte-for-byte identical to npm. Vendored SHA-256: `c4cb97a7e4372da41a1ff6ec6e1146f38deb125b733b8bbb2e9c52727953aba8`; size 853,083 bytes. Module/WASM assets load locally and are embedded by the Go host, so runtime decoding works offline.

LibRaw is offered upstream under LGPL-2.1 or CDDL-1.0; OpenLR distributes this component under the **LGPL-2.1** option. Retain all the original notices in `web/vendor/libraw/`, including the embedded DCB/FBDD and X3F notices and Emscripten license. This does not relicense OpenLR or MIT wrapper modules. Modification and reverse engineering for debugging modifications to this library are permitted under its license. Replace the independent `libraw.mjs` / `libraw.wasm` pair and rebuild OpenLR to use a compatible modified decoder; there is no signature or hash check preventing replacement.

Corresponding library and wrapper source archives ship in `web/vendor/libraw/source/`, rather than depending solely on an external link:

| Archive | Exact revision | SHA-256 |
| --- | --- | --- |
| `LibRaw.tar.gz` | `b860248a89d9082b8e0a1e202e516f46af9adb29` | `f5da1e522ea195b54b30f3ff105ef2193daa04ea165dea825b4d6fe9d886395b` |
| `colorhythm-libraw-wasm.tar.gz` | `9b0f59a5e0f6d3d12a8f6fa594015ef4f30a6e95` | `58de7e723dfd86beb9bf31aa6fd10d6c19022a28688ecf25cfed7b3959838863` |

To rebuild the library: extract the wrapper archive, extract the LibRaw archive into `packages/libraw.wasm/LibRaw`, activate Emscripten 4.0.8, install the wrapper's locked pnpm dependencies, and run its `packages/libraw.wasm/scripts/build.mjs`. That script contains the exact custom C API additions and Makefile transformations used by the upstream WASM build. Then build bindings/TypeScript using its package scripts. Preserve the ABI or adapt the OpenLR codec. The vendored binary was taken from the published package; OpenLR has **not** independently reproduced a byte-identical Emscripten build.

## Verification

Run `node --test tests/raw.test.js` with installed Chrome (`CHROME_CHANNEL` can choose another Playwright browser channel). The local HTTP fixture server must be reachable by that browser. The generated fixture in `tests/fixtures/dng.mjs` is original OpenLR test data: a valid uncompressed 12-bit RGGB DNG with red/green/blue patches, DNG color metadata, and **no embedded JPEG preview**. No personal or downloaded photograph is included.

Validated on Windows/Chrome on 2026-11-05: actual LibRaw WASM yields 128×96 pixels and correctly dominant RGB patches; orientation 6 yields 96×128; corrupt RAW rejection is followed by a successful decode; the original's SHA-256 stays unchanged; closing the returned bitmap clears its dimensions. Concurrent requests keep at most one live Worker, all six tested Worker creations terminate, and empty input is rejected before Worker creation. Application import/reload/export coverage is separate from this codec check. Physical camera RAW samples, optional compression, Safari/Firefox, very large inputs, wide-gamut/HDR, and native WebView module-Worker behavior require further platform coverage.

## Research references

[Official LibRaw documentation and licensing](https://www.libraw.org/docs), [Colorhythm source/API](https://github.com/colorhythm/libraw-wasm), [ybouane LibRaw-Wasm](https://github.com/ybouane/LibRaw-Wasm). Context7 `/ybouane/libraw-wasm` was consulted for the alternative Worker/API design. Colorhythm was selected because it exposes explicit disposal, typed errors, and redistributable package license files. The reference project's rendered-pixel API and algorithms were not copied into OpenLR.

## Explicit RAW transfer correction

[The real sensor experiment](../research/high-precision-raw.md) measured up to 17 byte levels of disagreement between the old default-gamma base and standard sRGB. [The pipeline experiment](../research/pipeline-precision.md) records the corrected contract and the separate remaining precision loss in editing. Existing RAW previews and rendered exports may change; stored originals and edit parameters are not rewritten. The generated DNG regression checks every bitmap channel against the actual 16-bit linear decode, with zero measured byte error on that fixture. This does not recover colors clipped by LibRaw's output-space conversion or establish full float editing.

Existing imported RAW thumbnails carry a derived-preview version. Rows without the current version regenerate only when their tiles enter the viewport. Regeneration uses the same decoder/renderer and is serialized with commands; it checks the current photo row before saving, preserves originals and recipes, and does not create edit history. The regenerated blob and version persist together. Local-folder thumbnails already regenerate from originals when viewed. Failures remain visible and do not replace the cache with invented pixels.
