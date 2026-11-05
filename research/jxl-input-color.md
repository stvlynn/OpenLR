# JPEG XL FLOAT input color: profiles, precision and explicit limits

Investigated 2026-11-05 against pinned libjxl `9f544641ec83f6abd9da598bdd08178ee8a003e0` (public version 0.7.0) and bundled skcms `64374756e03700d649f897dbd98c95e78c30c7da`. This record owns the color/precision evidence; the complementary [JPEG XL input investigation](high-depth-jxl.md) owns decoder reconstruction, alpha/orientation and workflow evidence. The [earlier export experiment](jxl-color-binding.md) remains separate: a working input extension does not add high-depth JPEG XL export to the product.

## Primary source and discovery

The fixed [decoder API](https://github.com/libjxl/libjxl/blob/9f544641ec83f6abd9da598bdd08178ee8a003e0/lib/include/jxl/decode.h), [pixel types](https://github.com/libjxl/libjxl/blob/9f544641ec83f6abd9da598bdd08178ee8a003e0/lib/include/jxl/types.h), [encoder input contract](https://github.com/libjxl/libjxl/blob/9f544641ec83f6abd9da598bdd08178ee8a003e0/lib/include/jxl/encode.h) and [basic information](https://github.com/libjxl/libjxl/blob/9f544641ec83f6abd9da598bdd08178ee8a003e0/lib/include/jxl/codestream_header.h) were read from the already fetched pinned source. The research browser's raw-GitHub requests for these exact files returned cache misses; the locally available exact-source inspection is not presented as a successful remote fetch. Context7 `/libjxl/libjxl` was consulted for profile and pixel-format API discovery; it returned current-main descriptions, so actual 0.7 behavior is established by pinned headers/implementation and executable probes.

The production baseline already decodes to native FLOAT internally and then calls skcms to produce RGBA8888. It is the terminal source-color/display conversion that loses source precision and gamut, rather than a libjxl UINT8 decode request. The new working route shares the public decoder core and existing linked CMS, and changes its terminal destination to linear-sRGB RGBA Float32. The fixed jSquash implementation remains a separate byte reference for comparisons; no second decoder or copied CMS implementation is introduced.

## FLOAT does not imply linear or original samples

Always associate returned samples with `JXL_COLOR_PROFILE_TARGET_DATA`. `ORIGINAL` describes the original-image color profile; it is not necessarily the interpretation of the current output buffer. They coincide for non-XYB/original-profile storage, while XYB output can have a different data encoding.

`JxlDecoderSetPreferredColorProfile` is a preference with a restricted effect, not a general ICC conversion API. The pinned header says it can affect a non-original/XYB image whose original profile is arbitrary ICC; it is ignored in most other cases. It must be called at COLOR_ENCODING after querying ORIGINAL and before querying DATA. Whether it succeeds or not, DATA still needs to be queried. Requesting linear sRGB and labeling every FLOAT output linear sRGB would therefore be incorrect.

The actual [target-profile selector](https://github.com/libjxl/libjxl/blob/9f544641ec83f6abd9da598bdd08178ee8a003e0/lib/jxl/decode.cc) uses output-encoding state for XYB and original color encoding otherwise. [OutputEncodingInfo::Set](https://github.com/libjxl/libjxl/blob/9f544641ec83f6abd9da598bdd08178ee8a003e0/lib/jxl/dec_xyb.cc) can preserve recognized structured original transfer functions/primaries even for XYB: sRGB, linear, gamma/DCI, BT.709, PQ and HLG have explicit paths. That source behavior qualifies broad introductory header wording that FLOAT output is linear sRGB. A source encoded in Display P3 or a nonlinear gamma can still return encoded FLOAT data requiring a transfer function and matrix.

The encoder contract is equally consequential:

- With `uses_original_profile=true`, both UINT16 and FLOAT samples are interpreted in the supplied original ICC/structured encoding. FLOAT is then a storage type, not an implicit request for linearization.
- With `uses_original_profile=false`, integer input is nonlinear sRGB, and floating input is linear sRGB. Supplying an original ICC does not change that input meaning. This is the XYB path and does not establish mathematically lossless source-sample preservation.
- `bits_per_sample` and `exponent_bits_per_sample` describe encoded source precision; `JxlPixelFormat` describes the transport buffer. A UINT16 transport can encode a lower integer source depth, and FLOAT output alone is not evidence of floating source precision.

Finite floating inputs may exceed [0,1] in this API, including negative out-of-gamut RGB and highlights. NaN/infinity are not valid source data. The decoder's FLOAT write path does not apply the unsigned-integer terminal clamp. Samples must remain finite through the working conversion; source depth, exponent bits and actual output storage are recorded separately.

## Existing skcms float destination and its boundaries

The pinned [skcms public header](https://github.com/google/skcms/blob/64374756e03700d649f897dbd98c95e78c30c7da/skcms.h) provides RGBA_ffff, straight-alpha format and an identity transfer function. A destination built by copying `skcms_sRGB_profile()` and replacing its transfer with identity retains sRGB colorants while producing linear rather than encoded output. Source samples use the actual DATA ICC. [Transform dispatch](https://github.com/google/skcms/blob/64374756e03700d649f897dbd98c95e78c30c7da/skcms.cc) inserts terminal clamping only for destination formats below floating RGB/RGBA; the float destination keeps signed/wide results.

This is the already linked CMS, not a new application dependency. The libjxl build prefixes its symbols as `jxl_skcms_*`; the wrapper must use the pinned rename header rather than link a second copy to resolve unprefixed calls. The scalar runtime decoder has one shared public libjxl implementation and one existing skcms implementation.

The documented skcms parametric transfer function reflects the input sign, evaluates the curve on the magnitude and restores the sign. That extension permits signed analytic SDR curves and linear profiles. It is CMS policy outside the ordinary unsigned ICC device domain; it should not be confused with LCMS's different negative-gamma behavior or silently generalized to every arbitrary profile.

Sampled curves and CLUTs have bounded input domains. Float transport cannot make their unknown extension outside [0,1] meaningful. The working binding detects native out-of-normalized-range color samples combined with table TRCs or A2B and returns explicit **`jxl-profile-range`** display compatibility. In-range tables can still be interpreted by the existing CMS. This keeps profile-domain clipping distinct from a terminal output clamp and avoids claiming preservation after an unsupported unbounded table transform.

The pinned `skcms_Parse` prefers A2B0, then A2B1. It has no general selectable rendering-intent API in this revision. Matrix/TRC conversion follows the established relative-white mathematics, but arbitrary table cases must not inherit a blanket relative-colorimetric claim from the JavaScript fixed-space core. The working path preserves the existing skcms-supported profile behavior, including its table priority, with independent references choosing the matching table. This is neither a print workflow nor general ICC conformance, BPC, perceptual gamut mapping or proofing support.

The JavaScript `convertInputPixels` contract remains normalized unsigned RGB. It is correct for the established integer TIFF/PNG/AVIF paths and does not become an arbitrary signed JXL ICC interpreter merely because JXL exposes FLOAT. Reusing the codec's existing CMS avoids copying that transform into JavaScript or expanding the unrelated normalized-input API.

## HDR remains an explicit compatibility boundary

The pinned [ICC generation](https://github.com/libjxl/libjxl/blob/9f544641ec83f6abd9da598bdd08178ee8a003e0/lib/jxl/color_management.cc) constructs PQ and HLG ICC descriptions as 4,096-entry UInt16 tone curves. Its source comments state that these are reasonable external-CMS approximations; native ExtraTF is more precise and supports unbounded mode. Generation also bounds table values, including HLG. A generated ICC plus FLOAT output is therefore not proof of exact analytical HDR conversion.

The original/data structured transfer functions and intensity metadata must accompany profile interpretation. The working binding recognizes structured PQ/HLG and returns **`jxl-hdr-transfer`** compatibility instead of claiming a scene-referred linear-radiance result. It preserves `intensityTarget`, source precision and compatibility provenance. A successful sRGB display decode is only a display interpretation; it does not implement scene-radiance recovery, a PQ absolute-nit working model, HLG viewing-condition adaptation or HDR output. Custom ICC HDR content that lacks structured identification remains limited to what the existing CMS can interpret; general identification of arbitrary HDR ICC profiles is not claimed.

## Alpha, orientation and first-frame scope

The public decoder core normalizes orientation and stops at the first full display image with default coalescing. Codestream orientation is authoritative; EXIF must not rotate the result again. [ConvertToExternal](https://github.com/libjxl/libjxl/blob/9f544641ec83f6abd9da598bdd08178ee8a003e0/lib/jxl/dec_external_image.cc) already unpremultiplies associated samples, using the pinned alpha routine's small-alpha guard. Consequently the new working CMS call declares straight input and must not divide alpha again. The byte route deliberately retains the published decoder's existing alpha policy for legacy-regression parity. Detailed alpha and coalescing evidence belongs to the complementary input record.

The fixture suite includes opaque low-bit ramps separately from fractional/zero/tiny alpha. A partially transparent color comparison by itself cannot establish source-word precision because alpha compositing or unpremultiplication can introduce independent differences.

## Reproducible generated fixtures and numerical checks

The original sample definitions are [tests/fixtures/jxl-input.mjs](../tests/fixtures/jxl-input.mjs); small actual codestreams and metadata live under `tests/fixtures/jxl/`. No photographs, operating-system profile assets or competitor material are used. The separate validation-only `jxl_input_fixture` target uses public libjxl UINT16/FLOAT input with true source precision in BasicInfo; the application encoder's existing 8-bit export API is unchanged. No validation WASM is committed.

[The experiment](../scripts/experiments/jxl-input-color.mjs) regenerates those files through that tool, inspects actual native FLOAT before CMS, then compares working FLOAT and byte output. [Its independent LCMS adapter](../scripts/experiments/jxl-input-cms.py) opens the actual DATA ICC and constructs its own linear-sRGB destination from white/primaries and gamma 1. Normalized cases compare against that independent CMS; signed analytic cases additionally compare against the existing signed named-space core. XYB loss is measured separately from lossless original-profile cases.

```powershell
# Build the scalar public decoder and validation tools with the existing source recipe.
node scripts/experiments/jxl-input-color.mjs --generate
node scripts/experiments/jxl-input-color.mjs
```

The maintained generator needs the ignored validation encoder/inspector and native LCMS. Ordinary browser/CI tests consume the small committed files offline and do not require that build tool, native CMS or a multi-megabyte validation WASM. The experiment writes its full report under ignored `.workspace/jxl-input-color/`; the fixture manifest records source declarations and measured decoder boundaries. The fixture generator is a reproduction procedure, not a claim of byte-identical output from different Emscripten/compiler environments.

## Independently discovered XYZ LUT normalization defect

Actual generated original-profile JXL files exposed a pinned skcms PCSXYZ range defect. The independently loaded LCMS 2.19 reference used the actual DATA ICC, an independently constructed linear-sRGB destination, no optimization/cache or BPC, and the intent selecting the same table as skcms. The first B-only `mAB` fixture produced exactly half the LCMS linear result. Merely changing LCMS's intent did not remove the discrepancy. Source inspection then showed that `read_tag_mab` inserts `65535/32768` into the parsed matrix when a matrix is present, but never inserts it for B-only tags. Inserting that factor before nonlinear B curves also changes the result: an identity matrix followed by gamma-2 B curves produced twice the LCMS output.

The working adapter corrects this source-XYZ normalization using the existing CMS's selected-tag accessor and parsed fields. For selected `mAB` with XYZ PCS, it removes the parser's premature factor from the parsed matrix when present, runs the existing stages, then applies the factor to the final linear RGB. Scalar multiplication commutes with the final linear XYZ-to-RGB matrix. It does not commute with nonlinear B curves, which is why stage order matters. The alpha channel and published byte path are unchanged. Identity and nonlinear B fixtures, with and without M/matrix, retain the formerly failing cases as regressions. A2B1-only and differing A2B0/A2B1 cases establish table absence/priority separately.

An actual `mft2` XYZ fixture exposed the same missing terminal `65535/32768` factor; that type receives only the final normalization, since this parser has not already inserted it. This is an encoded-PCS range adapter, not a new LUT interpreter or color engine. The [ICC v4.3 specification](https://www.color.org/specification/icc1v43_2010-12.pdf), sections 6.3.4 and 10.8–10.10, defines the corresponding encodings and processing order. Lab tables use a different encoding and are not given this XYZ factor.

The `mft1` XYZ case is deliberately different. ICC section 10.9 says that 8-bit PCSXYZ has not been defined and its interpretation is implementation-specific. The actual LCMS probe chooses a scaling convention, but matching that convention would not establish a normative source meaning. This shape returns **`jxl-profile-unsupported`** display compatibility. The generated `lut-mft1-16` fixture records the actual boundary. No presumed `255/128` rule is introduced.

## Measured precision, alpha and source-codec limitation

The original-profile integer sRGB ramp contains 512 neighboring red source words within a narrow interval. Native and working FLOAT retain 512 distinct values; the published byte path retains 3. The GRAY kTRC ramp similarly retains 512 versus 2. Display-P3 primaries produce signed linear-sRGB output (approximately -0.225 to 1.225), rather than a clipped encoded-sRGB bridge. Source-normalization roundoff is at most one Float32 rounding step for the tested integer images.

The 32-bit, 8-exponent-bit linear and P3 source fixtures preserve their original native FLOAT values exactly, including -0.125 and 1.5. Working P3 reaches approximately 2.769. The existing CMS uses rounded ICC colorants and approximate arithmetic: even a structured linear-sRGB source is not a bitwise identity to the canonical skcms destination. Its signed/HDR samples independently differ from LCMS by up to 4.10e-4; the P3 integer fixture differs by up to 4.83e-4. These measured CMS differences must not be misreported as source quantization. The small metadata manifest records full precision declarations, sample prefixes and independent reference/error measurements, rather than implying identical mathematics across CMS implementations.

The actual associated-alpha fixture required a validation-tool workaround for this pinned encoder: its public buffer conversion hardcodes straight input and asserts if the metadata declares association before that conversion. The tool ingests associated sample bytes with a temporarily straight flag, then sets the actual associated extra-channel metadata before codestream output. The resulting file declares associated alpha; the independent native inspection returns straight `[.25,.125,.0625]` from source words `[8192,4096,2048]` at alpha `32768`. A source pixel with RGB and alpha word 1 decodes to straight RGB 1 with alpha 1/65535. This proves actual association handling; the earlier generated file with a false association flag was not accepted as evidence. Separate straight-alpha cases preserve hidden RGB at zero alpha.

The maintained generator also records a known pinned-pair limitation instead of silently discarding it. For a lossless original-profile FLOAT row `[-.25 + x*.625, .5, .25, 1]`, widths 4 and 8 return positive red values multiplied by 65536 and 16777216 respectively. The same row at width 32 is exact. This occurs with linear, P3 and table ICC sources, so it is independent of the profile/CMS. The experiment uses the same pinned encoder and decoder and therefore cannot localize the fault to one side. It does not justify a guessed product dimension gate or a general lossless-float claim. The committed precision cases use the separately measured exact roundtrips; this limitation remains reproducible in `smallFloatRoundtripAblation`.

The 32-wide table-FLOAT fixture is also native-exact, including negative and >1 values. Its working result is explicitly `jxl-profile-range` byte compatibility, since sampled TRCs do not define an unbounded extension. Structured PQ/HLG fixtures similarly retain their true source declarations but return `jxl-hdr-transfer`. XYB FLOAT is a separate lossy example and is never compared to original samples with a lossless assertion.

Final execution on Windows with Node 24.9.0, Python 3.14 and native LCMS 2.19 generated 21 codestreams totaling 17,592 bytes. Fifteen supported cases, totaling 15,374 pixels, passed the explicit independent-CMS error bound of 5e-4 in linear RGB. The HDR, undefined-PCS and out-of-domain table cases passed their separate compatibility assertions. Both `--generate` and a fresh read-only fixture rerun completed successfully; syntax and Prettier checks also passed. Browser, desktop and legacy-byte acceptance are recorded separately by the workflow owner.

| Measured comparison                                                                            | Maximum absolute linear-RGB difference |
| ---------------------------------------------------------------------------------------------- | -------------------------------------: |
| sRGB integer versus LCMS                                                                       |                               2.005e-6 |
| P3 integer versus LCMS                                                                         |                               4.826e-4 |
| GRAY kTRC versus LCMS                                                                          |                               7.661e-8 |
| Signed linear FLOAT versus LCMS                                                                |                               4.098e-4 |
| `mAB` identity B, with/without matrix, A2B1-only and A2B0-priority versus matching LCMS intent |                               3.231e-4 |
| `mAB` gamma-2 B, with/without matrix versus LCMS                                               |                               3.176e-4 |
| `mft2` XYZ versus LCMS                                                                         |                               3.231e-4 |
| Signed P3 FLOAT versus existing named-space core                                               |                               7.689e-4 |

The last row is a separate signed analytic reference with a 1e-3 bound, rather than a claim that LCMS and skcms use the same negative-curve extension. The actual DATA ICC rather than an idealized named profile is the source for every LCMS row.
