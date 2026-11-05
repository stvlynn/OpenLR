# Output color spaces

JPEG, PNG, TIFF, AVIF and JPEG XL export can encode the current edited image as sRGB, Display P3, Adobe RGB, ProPhoto RGB or Rec.2020 gamma 2.4 SDR. Choose **Color space** in Export, or use the same command:

```sh
node cli/openlr.mjs export --format image/png --colorSpace display-p3 --output photo.png
node cli/openlr.mjs export --format image/tiff --colorSpace prophoto-rgb --output photo.tif
```

The default is sRGB. `web/export-color.js` owns format capabilities used by the GUI and export dispatcher; `web/color-spaces.js` owns names and definitions used by the schema and conversion. Original, original-with-settings, XMP, DNG and video reject explicit `colorSpace`; their existing preservation/encoding contracts apply. The UI only offers supported combinations. Unsupported agent requests fail visibly, rather than silently relabeling pixels.

## Pixel and profile contract

Export consumes the same edited sRGB canvas after crop, size and watermark as before. A worker converts unassociated 8-bit sRGB samples through relative-colorimetric RGB matrices and transfer functions, with Bradford white-point adaptation. Only the final target samples are clipped and quantized. Alpha is copied unchanged before compression; PNG/TIFF and quality-1 AVIF/JPEG XL preserve it exactly. Lossy AVIF/JPEG XL may also compress alpha. JPEG first composites transparency on black in the current sRGB rendering space, then converts the opaque result.

Five independently generated ICC v4.3 matrix/TRC profiles describe those exact spaces. No Adobe or operating-system profile is distributed. Display P3 is D65 with the sRGB curve, not DCI-P3. ProPhoto uses D50 and its linear black toe. Rec.2020 is explicitly gamma 2.4, full-range SDR; it does not imply PQ, HLG or HDR output. Definitions, source specifications and independent measurements are in [the transform experiment](../research/color-transform-experiment.md).

The content is still derived from the existing **8-bit sRGB editing pipeline**. Encoding it in a larger space does not recover source gamut or sensor precision already discarded at import/render. Float conversion primitives are available for a future high-precision pipeline, but that pipeline is not implemented by this change. General input ICC conversion, perceptual gamut mapping, print CMYK, soft proofing and HDR display remain separate work.

## Containers and re-import

- **PNG**: non-sRGB output writes explicit RGBA samples and an `iCCP` chunk with the generated profile. The encoder uses the existing pako compression adapter, avoiding host canvas color conversion and conflicting color chunks. Default sRGB continues through the native PNG encoder.
- **JPEG**: converted samples are placed literally in an intermediate canvas and encoded by the host. The adapter replaces ICC APP2 segments and removes stale EXIF/XMP declarations before embedding the matching profile. JPEG scan data and APP14 transform semantics are preserved. Normal sRGB retains the existing native encoding route.
- **TIFF**: one dynamic TIFF serializer replaces the former fixed-offset UTIF export helper. It writes straight RGBA, correctly sized strips and ICC tag 34675. Ordinary output is classic little-endian TIFF; offsets exceeding that format use BigTIFF layout. Multi-gigabyte allocation and BigTIFF interoperability have not been exercised; memory/runtime constraints still apply and the current TIFF importer accepts classic TIFF only.

- **AVIF**: rebuilt libavif bindings encode converted RGB samples and ICC, with unspecified CICP primaries/transfer to avoid conflicting declarations. The actual YUV matrix and full range remain explicit; quality 1 selects identity-matrix 4:4:4 lossless coding.
- **JPEG XL**: a public libjxl API binding preserves the supplied original profile for target-space samples and all lossless output. Lossy sRGB uses the existing XYB route. VarDCT remains the lossy compression choice after [measurement](../research/jxl-color-binding.md); setting ICC alone while leaving `uses_original_profile=false` would misinterpret non-sRGB integer samples.

PNG/JPEG import uses the host's color-managed image decoder. RGB TIFF and AVIF with an embedded profile are repackaged as a tagged PNG for that same native color conversion, then returns to the existing sRGB canvas and orientation path. ICC headers, tag-table bounds and known matrix/curve payloads are validated before decoding; malformed structure and non-RGB/profile-layout mismatches fail visibly. Unknown standard LUT payload types receive container-boundary checks only, so this is not proof that the host CMS supports every structurally valid profile. This bridge is not a new ICC interpreter; supported profile details remain dependent on the host CMS. TIFF without a profile keeps the existing decoder behavior. AVIF without ICC uses conventional sRGB compatibility for CICP primaries 1/2 and transfer 13/2 (unspecified 2 is an assumption, not evidence of its source space). Other CICP combinations use the host decoder on the original AVIF; unavailable host support fails visibly. This does not add an HDR editing pipeline. JPEG XL retains its existing skcms conversion to sRGB on decode. The extra PNG bridge costs memory and compression work, so arbitrary large-profile TIFF imports are not claimed as benchmarked.

The existing worker runner owns transfer and lifetime. Worker startup failure uses the same kernel on the main thread, with the existing diagnostics; processed decode errors do not trigger a second decoder. Original bytes and photo recipes are unchanged by export.

## Verification

The internal [linear working-frame API](linear-working-frames.md) also converts genuine float results directly into 16-bit ICC TIFF samples, using this same container writer. It is separately verified by `tests/float-tiff.test.js` and `tests/float-raw.test.js`; the application export command continues to use the existing 8-bit recipe path until process-version migration is integrated.

```sh
node --test tests/color-spaces.test.js tests/color-containers.test.js tests/color-workflow.test.js
node scripts/native-smoke.mjs /path/to/OpenLR
```

Local Windows/Chrome checks exercise all 25 space/format combinations through real export and re-import, the GUI Save download, the shared agent dispatcher, rejected combinations, original-byte preservation and unchanged edits. Four midtone color patches round-trip with a maximum error of 2 RGB byte levels for PNG/TIFF/AVIF/JPEG XL and 4 for quality-1 JPEG. These samples do not bound all possible saturated or near-black colors; the separate 5,265-color CMS experiment measures broader conversion behavior and documents quantization limits.

Container tests independently inflate PNG and validate CRC, decode TIFF strips/profile offsets with UTIF, and check JPEG multi-segment ICC replacement without changing compressed scans. A 170,003-byte profile payload tests large profile offsets/segmentation. Pillow/Little CMS independently parses and transforms 15 genuine-profile files. Python/Pillow is optional validation tooling, not an application dependency; when missing, that independent check is explicitly skipped, not counted as a CMS pass. Reproduction with required tooling is documented in the experiment record. The native smoke repeats all 25 export/import/sample comparisons through the actual GUI and CLI; each platform's result must come from its own run.

A local Node 24 microbenchmark converted a 1024×1024 RGBA frame through each non-sRGB target four times: Display P3 149/134/131/130 ms, Adobe RGB 151/149/156/185 ms, ProPhoto 173/164/159/158 ms, Rec.2020 159/146/143/143 ms. These measurements cover conversion and its allocations only, not encoding, file IO, native fallback UI latency or other hardware. All color channels came from a repeated byte ramp; there is no universal throughput claim.

Container references: [ICC profile embedding](https://archive.color.org/files/technotes/ICC-Technote-ProfileEmbedding.pdf), [PNG iCCP specification](https://www.w3.org/TR/png-3/#11iCCP), and [TIFF/BigTIFF format documentation](https://libtiff.gitlab.io/libtiff/specification/index.html). The implementation uses existing pako under its retained licenses; no additional runtime dependency is added.

## Rebuilding AVIF and JPEG XL

The pinned source recipes, Emscripten toolchain and install steps are in [codec-color](../scripts/codec-color/README.md). These builds replace the previous npm encoders and AVIF decoder; there is one production encoder per format with single-thread/threaded variants, plus JPEG XL SIMD. The JPEG XL inspector is validation tooling and is not shipped. [AVIF experiments](../research/avif-color-binding.md) inspect actual container and AV1 bitstream color declarations; JPEG XL experiments inspect decoded original/data ICC and samples. Independent Little CMS checks distinguish real conversion from merely replacing a profile.
