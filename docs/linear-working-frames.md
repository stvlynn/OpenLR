# Linear working-frame kernel

Choose **Processing → Linear** in the detail editor, or run `processing --version 2`, to use the float pipeline for a still photo. **Original** (`--version 1`) retains the byte pipeline. Existing photos and ordinary new imports keep their current/default legacy processing unless explicitly switched; an imported OpenLR XMP recipe carries its own version. The GUI and CLI use the same dispatcher. Video remains on original processing.

## Boundaries

`decodePhotoFrame(file)` returns an owned straight-alpha RGBA Float32 frame in signed, unbounded linear sRGB. RAW uses actual 16-bit wide LibRaw output and records its decoder, matrix and precision provenance. The distinct `decodePhotoLinear` contract used by DNG/HDR remains linear sRGB. Other image formats currently derive a frame from the existing 8-bit display decoder and explicitly report `rgba8-display` provenance; high-depth TIFF/AVIF/JXL input is not yet implemented in this API.

`renderFrame(frame, edit, maxSize)` copies source samples before edits. Stage order is fill, red-eye, repairs, depth blur, local masks, optics/TCA, crop/turn/flip/resize, global tone, curve, HSL/point color, then spatial effects. Originals are never mutated. Stage modules own the same rules used by the legacy adapter:

- Local and global exposure/contrast/saturation and repair blending operate in linear light. Healing adds an unclipped mean residual; each repair samples an immutable pre-stroke state. Range masks share a pre-blur/pre-mask reference.
- Color selection uses continuous signed encoded sRGB against existing hex swatches. Luminance selection uses linear RGB directly. Global tonal influence is bounded to [0,1], while RGB remains unbounded.
- Curves interpolate existing encoded-domain control stops continuously and extend as identity outside [0,1]. HSL maps signed/HDR samples into an affine envelope and restores that envelope after adjustment; unmatched colors remain unchanged.
- Geometry uses alpha-weighted linear bilinear sampling. Resize clamps edge coordinates; optics uses a transparent exterior and conservative TCA alpha. Integer crops, quarter turns and reflections copy samples exactly.
- Existing fill patches retain their honest RGBA8 precision: only patch pixels are decoded and composed into the float base. Red-eye changes corrected red through the continuous encoded-domain rule without quantizing other channels.
- Spatial effects retain alpha and ignore invisible neighbor colors. Defocus uses normalized premultiplied convolution, spreading coverage with the blur; focused samples remain exact.

`frameCanvas` is a terminal sRGB display adapter. `encodeFrameTiff` converts the float result directly to target-space Uint16 samples, then uses the existing worker and TIFF writer with a matching ICC. Both output adapters clip only at their representable output boundary. Source values clipped earlier inside LibRaw cannot be reconstructed. Watermarks rasterize only their text/shadow layer and alpha-compose it into the linear result. PNG, JPEG, AVIF and JPEG XL convert directly from the float result into the requested target space before terminal 8-bit quantization; they do not pass through an sRGB preview. JPEG composites transparency over black in linear light. High-depth output beyond TIFF remains unimplemented.

## Verification

```sh
node --test tests/float-color.test.js tests/float-local.test.js tests/float-geometry.test.js tests/float-render.test.js tests/float-tiff.test.js tests/float-raw.test.js tests/float-mask-preview.test.js
node --test tests/process-version-transport.test.js tests/process-version-workflow.test.js tests/sync.test.js tests/local.test.js
npm test
```

Numerical tests cover negative values, highlights, sub-byte differences, alpha coverage, immutable sources and captured legacy results. The shared renderer retains all 256 gray levels through local +4 EV followed by global −4 EV. TIFF tests independently decode true 16-bit low samples and verify strip byte counts, sliced arrays, large ICC offsets and exact legacy encoding. Browser RAW tests use generated sensor DNGs and actual WASM, including worker/fallback equivalence, wide-color reconstruction, orientation, failure recovery and source preservation. Their generated fixtures are evidence of these numerical cases, not proof of all camera formats or full application migration.

Browser workflow tests verify explicit upgrade, undo/redo/reset, version-preserving comparisons, named versions, presets, XMP including depth settings, reopening, true TIFF16 output and unchanged legacy pixels. Original source caches include processing version; recipe changes decode for the requested version before writing thumbnails. Model analysis receives a separate display surface associated with the owned float source. Range overlays select at original resolution using the same immutable float fill/red-eye/repair reference as adjustments, then downsample coverage; resampling source colors first could invent a selected color. Commands serialize source changes with the active recipe; slider preview additionally checks recipe identity and cache processing version. Sync and library changes invalidate source caches.

Local sidecars and sync manifests use their existing format-version rejection mechanism to protect new recipes from older clients. Saved linear versions also require the newer envelope even when current processing is original. Concurrent recipe-version transitions are atomic sync conflicts. See [versioning decision](decisions/008-processing-version.md), [local folders](local-folders.md) and [sync](library-sync.md).

The native smoke suite exercises actual RAW opt-in, CLI TIFF16 low-bit inspection, reset and switching back. The native local suite verifies sidecar persistence, saved versions, restart and rejection of unsupported recipes. Each platform must pass its own run; browser tests alone do not establish native acceptance.
