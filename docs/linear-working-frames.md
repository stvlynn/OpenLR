# Linear working-frame kernel

This is an implemented internal processing contract, not an activated GUI/CLI process version. Current application imports, previews, exports and saved recipes retain the legacy behavior described in the README. Do not interpret passing kernel tests as completed catalog migration or native end-to-end acceptance of a new process version.

## Boundaries

`decodePhotoFrame(file)` returns an owned straight-alpha RGBA Float32 frame in signed, unbounded linear sRGB. RAW uses actual 16-bit wide LibRaw output and records its decoder, matrix and precision provenance. The distinct `decodePhotoLinear` contract used by DNG/HDR remains linear sRGB. Other image formats currently derive a frame from the existing 8-bit display decoder and explicitly report `rgba8-display` provenance; high-depth TIFF/AVIF/JXL input is not yet implemented in this API.

`renderFrame(frame, edit, maxSize)` copies source samples before edits. Stage order is fill, red-eye, repairs, depth blur, local masks, optics/TCA, crop/turn/flip/resize, global tone, curve, HSL/point color, then spatial effects. Originals are never mutated. Stage modules own the same rules used by the legacy adapter:

- Local and global exposure/contrast/saturation and repair blending operate in linear light. Healing adds an unclipped mean residual; each repair samples an immutable pre-stroke state. Range masks share a pre-blur/pre-mask reference.
- Color selection uses continuous signed encoded sRGB against existing hex swatches. Luminance selection uses linear RGB directly. Global tonal influence is bounded to [0,1], while RGB remains unbounded.
- Curves interpolate existing encoded-domain control stops continuously and extend as identity outside [0,1]. HSL maps signed/HDR samples into an affine envelope and restores that envelope after adjustment; unmatched colors remain unchanged.
- Geometry uses alpha-weighted linear bilinear sampling. Resize clamps edge coordinates; optics uses a transparent exterior and conservative TCA alpha. Integer crops, quarter turns and reflections copy samples exactly.
- Existing fill patches retain their honest RGBA8 precision: only patch pixels are decoded and composed into the float base. Red-eye changes corrected red through the continuous encoded-domain rule without quantizing other channels.
- Spatial effects retain alpha and ignore invisible neighbor colors. Defocus uses normalized premultiplied convolution, spreading coverage with the blur; focused samples remain exact.

`frameCanvas` is a terminal sRGB display adapter. `encodeFrameTiff` converts the float result directly to target-space Uint16 samples, then uses the existing worker and TIFF writer with a matching ICC. Both output adapters clip only at their representable output boundary. Source values clipped earlier inside LibRaw cannot be reconstructed. Float watermark composition and other high-depth output formats are not yet wired.

## Verification

```sh
node --test tests/float-color.test.js tests/float-local.test.js tests/float-geometry.test.js tests/float-render.test.js tests/float-tiff.test.js tests/float-raw.test.js
npm test
```

Numerical tests cover negative values, highlights, sub-byte differences, alpha coverage, immutable sources and captured legacy results. The shared renderer retains all 256 gray levels through local +4 EV followed by global −4 EV. TIFF tests independently decode true 16-bit low samples and verify strip byte counts, sliced arrays, large ICC offsets and exact legacy encoding. Browser RAW tests use generated sensor DNGs and actual WASM, including worker/fallback equivalence, wide-color reconstruction, orientation, failure recovery and source preservation. Their generated fixtures are evidence of these numerical cases, not proof of all camera formats or full application migration.

Before application activation, validate absent recipe versions as legacy, upgrade/undo/reset, version-preserving comparisons, decode cache identity and stale work, named versions, copy/paste, presets, XMP including depth settings, local sidecar presence and cross-device version conflicts. New native GUI/CLI acceptance must exercise that activated path on all supported operating systems.
