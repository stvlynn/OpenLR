# PNG input color characterization and independent measurements

Investigated and implemented 2026-11-05 on Windows x64, Node.js 24.9.0 and Python 3.14. This record covers the source color interpreter. PNG reconstruction, transparency, Adam7 and first-frame handling belong to the separate [numeric decoder investigation](high-depth-png.md), while [linear working frames](../docs/linear-working-frames.md) owns application behavior. Research evidence does not promote every PNG feature into a supported OpenLR capability.

## Primary sources and authority

The normative format source is [PNG Third Edition, W3C Recommendation of 24 June 2025](https://www.w3.org/TR/2025/REC-png-3-20250624/), particularly sections 4.3, 11.3.2, 13.13 and 13.14. The inspected native-library references are the pinned [libpng 1.6.55 manual](https://github.com/pnggroup/libpng/blob/v1.6.55/libpng-manual.txt), [chunk readers](https://github.com/pnggroup/libpng/blob/v1.6.55/pngrutil.c), [metadata setters](https://github.com/pnggroup/libpng/blob/v1.6.55/pngset.c) and [public header](https://github.com/pnggroup/libpng/blob/v1.6.55/png.h). These sources describe library behavior; they do not override PNG 3.

Context7 was queried for libpng. Its resolver returned `/the-swift-collective/libpng`, a third-party packaging/documentation mirror, rather than an official `/pnggroup` result. It was used only for API discovery (`png_get_gAMA`, `png_get_cHRM`, gamma direction, preservation and expansion controls). API details and claims were checked against the official pinned sources above. No mirrored source, external PNG implementation, profiles or photographs are imported into the runtime.

## Characterization selection

PNG 3 section 4.3 defines the order **cICP > iCCP > sRGB > gAMA and cHRM**. The last two are complementary transfer/colorant metadata at the same priority. This is different from the AVIF ICC-first contract; do not reuse the AVIF selection rule merely because both formats can contain ICC and CICP.

The specification describes the highest-priority characterization understood by a decoder. OpenLR deliberately takes a valid but unsupported higher-priority declaration to explicit display compatibility rather than silently applying a lower declaration that could mislabel HDR/narrow-range data. It returns a stable reason and preserves selected-source provenance. Malformed known data fails visibly according to the decoder's validation contract; that strict application policy is distinct from PNG's permission to recover from some ancillary-chunk errors.

| Declaration | Encoding and validity | Implemented native-float interpretation |
| --- | --- | --- |
| `cICP` | Four UInt8 fields. RGB PNG requires matrix coefficients 0. Full-range flag 0/1; 0 is valid narrow range, not a malformed full-range image. Must precede PLTE/IDAT | Full range, transfer 13, primaries 1 or 12 use existing exact sRGB or Display P3 definitions. Other valid combinations return `png-cicp`; they do not fall through to ICC or sRGB |
| `iCCP` | Printable Latin-1 profile name of 1–79 bytes, zero separator, compression method 0 and zlib-compressed profile. RGB ICC is required for PNG types 2/3/6; GRAY ICC for 0/4 | Existing RGB XYZ matrix/TRC input/display subset, plus the verified GRAY XYZ kTRC subset described below. Unknown LUTs/Lab PCS/classes/interpretation return explicit compatibility. Mismatch or malformed profile fails |
| `sRGB` | One rendering-intent byte, 0–3. Discouraged alongside iCCP. If approximate gAMA/cHRM are also written, the specification supplies their matching values | Existing piecewise sRGB decode, not gamma 2.2. The intent is recorded; the current working conversion remains the established relative-colorimetric source transform, without implementing new perceptual/saturation/proofing behavior |
| `gAMA` | Four-byte unsigned value divided by 100000; 45455 approximates 1/2.2. A zero value is meaningless and PNG 3 §13.13 says to ignore it | Decode normalized color with exponent **1/gAMA**. Zero is ignored with `png-zero-gamma` warning provenance. Alpha is untouched |
| `cHRM` | Eight four-byte unsigned xy values divided by 100000: white, red, green, blue | Reuse existing native-white colorant derivation, Bradford adaptation to the core's D50, then its D50-to-linear-sRGB matrix. No ICC serialization or fixed-point profile roundtrip |

`gAMA=45455` alone is not an sRGB declaration. For example, an encoded low value 0.02 decoded by `value^(1/0.45455)` differs materially from the sRGB linear toe `value/12.92`. Likewise `gAMA=100000` means a linear source; applying an sRGB inverse curve would darken it incorrectly. The exponent describes desired output intensity under the format's viewing convention; it cannot recover unknown scene radiometry. Its reciprocal direction follows PNG's encoder and decoder equations, and was independently tested below.

`cHRM` supplies chromaticities, not ready-to-use D50 ICC colorants. Adapt from its own white exactly once. Conversely an ICC input's stored colorants are already PCS-relative D50 and its `chad` must not be applied again. `createChromaticInputTransform` in `web/color-spaces.js` reuses `colorants`, `adaptation`, `product` and `matrixToLinearSrgb` from that existing owner; `web/png-color.js` contains no duplicate matrix, primary list or Bradford implementation. It rejects non-finite, degenerate or nonphysical xy pairs (x<0, y≤0, x+y>1) in this supported subset. PNG integer precision is retained; its xy coefficients are interpreted as stored.

Partial and absent characterization need an explicit assumption, because PNG does not define every untagged image to be sRGB. Section 13.13 allows viewers to select a likely default and tells document viewers to handle unknown PNG consistently with other untagged images. OpenLR retains its existing sRGB assumption, recorded as `assumed-srgb` plus `colorAssumptions:['srgb']`. With gAMA alone, preserve its actual power curve and assume only sRGB primaries. With cHRM alone, preserve its actual primary/white definition and assume only the sRGB transfer curve. These assumptions are visible in provenance, not asserted as measured source colorimetry. They do not create an extra GUI warning for ordinary untagged photos.

## Supplemental metadata and alpha

`mDCV` describes the mastering display volume, not the source RGB encoding. PNG 3 requires an accompanying cICP and permits mDCV with SDR as well as PQ/HLG. `cLLI` describes content maximum and frame-average light levels for HDR tone-mapping decisions; zero means unknown. Both are supplemental static metadata, absent from the source-color priority table. Their presence must not replace cHRM/ICC primaries, choose a transfer curve, or imply implemented tone mapping. The decoder validates their 24/8-byte payloads and keeps owned raw metadata; the color converter follows the actual cICP characterization. Unsupported PQ, HLG or narrow range uses explicit compatibility rather than inventing an SDR mapping.

PNG alpha is straight and linear coverage. No gAMA/ICC operation applies to it, including at alpha zero. Transparency matching happens before any color conversion or precision reduction. Palette entries remain 8-bit RGB regardless of index depth. sBIT is significance metadata, not permission to discard stored low bits during normal editing; provenance records it separately from actual stored source depth. A Float32 transport does not establish 32-bit source precision.

The decoder's recoverable out-of-palette-index condition has its own meaning: substituted opaque-black damaged pixels carry `png-palette-index` plus a count. `inputPrecisionDescription` appends **Some pixels could not be recovered.** for that warning in either native or compatibility provenance. Ordinary untagged-color assumptions, zero-gamma and unrelated metadata warnings do not trigger that damaged-pixel message. Animation provenance uses the shared decoder field `decodedFrame:'animation-first'`; color interpretation neither selects nor composites a second frame.

## GRAY ICC subset: specification and numerical evidence

[ICC.1:2022 sections 8.3.4, 8.4.4 and annex F.2](https://www.color.org/specification/ICC.1-2022-05.pdf) define grayTRC as the achromatic PCS coordinate. For XYZ PCS, multiply the decoded curve by PCS white. Under the established relative-white transform this is neutral linear sRGB, so the output channels equal the forward kTRC value. [LCMS 2.17's gray-input pipeline](https://github.com/mm2/Little-CMS/blob/lcms2.17/src/cmsio1.c) independently implements kTRC followed by a PCS-D50 column. This is not a reason to apply `wtpt` or `chad` again.

A preliminary actual native LCMS 2.19 Gray→XYZ Float32 transform used gamma 2.2 and six inputs including 1/65535, 0.01, 0.1, 0.5 and 1. Its maximum absolute difference from `gray^2.2 × [.9642,1,.8249]` was **3.1090×10⁻⁸**. LCMS's decimal D50 constants differ slightly from the core's exact ICC fixed-point D50 representation; the maintained comparison below instead uses an independently constructed linear-sRGB destination, keeping the CMS's own relative-white convention internally consistent.

`createGrayProfileToLinearSrgb` shares the existing container checks, forward curve parser/evaluator and class/LUT precedence restrictions. It supports GRAY, XYZ PCS, input/display class, kTRC, legal v2 curv or v4 curv/para 0–4. Its shared RGBA call shape requires identical gray RGB inputs and writes only those three channels. GRAY LUT/Lab or other unsupported profiles return compatibility reasons; malformed curves still throw. The default RGB validator remains strict and cannot accept a GRAY profile accidentally. No gray ICC runtime is introduced into the separate TIFF/AVIF RGB paths by this PNG extension.

## Independent native PNG and CMS experiment

The original validation tools are [the Node runner](../scripts/experiments/png-input-color.mjs) and [Python ctypes adapter](../scripts/experiments/png-input-color.py). They use already installed native libraries, selected by environment overrides or system/ignored-tool discovery. Tested libraries were **libpng 1.6.46** and **LCMS 2.19**, not the 1.6.55 source revision consulted for current API documentation. No application dependency or codec binary was added.

The experiment writes generated 16-bit PNG fixtures with Paeth filtering through the independent fixture writer, reads them through production `readPng`, then converts them with production `convertPngPixels`. Native libpng reads the same complete PNGs through the low-level no-transform API: no gamma correction, sBIT shifting, alpha premultiplication, strip16 or canvas conversion. Its decoded big-endian words, including alpha, must match every original word exactly. Its gAMA/cHRM getters must match the stored metadata. These callbacks are used only for known valid generated inputs; this ctypes experiment is not a malformed-file safety harness.

Native LCMS independently constructs an RGB profile from each PNG's actual xy white/primaries and a forward gamma **1/gAMA**, using `cmsCreateRGBProfile`/`cmsBuildGamma`. It constructs a separate linear-sRGB target from primary specifications and gamma 1, then runs relative-colorimetric Float32 input/output with NOOPTIMIZE|NOCACHE and no BPC. This reference does not reuse OpenLR's source or target matrix coefficients. GRAY cases open the actual generated embedded ICC and use Float32 gray transport. The shared source-color experiment therefore checks the implemented math, not merely metadata labels.

| Cases | Samples per case | Maximum absolute linear-sRGB channel difference |
| --- | --- | --- |
| sRGB primaries/D65, gAMA 1 / .45455 / .55556 | 5,426 | 1.111×10⁻¹⁶ |
| Display P3 primaries/D65, same three gamma values | 5,426 | 1.193×10⁻⁷ |
| Wide primaries/D50 from stored PNG xy, same three gamma values | 5,426 | 1.193×10⁻⁷ |
| Embedded GRAY analytic gamma profile | 4,096 | 1.193×10⁻⁷ |
| Embedded GRAY five-point sampled curve | 4,096 | 1.056×10⁻⁵ |

Every native PNG raw word was exact in all **11 cases**. Each RGB case contains a 17³ color cube and all 513 low gray codes 0–512; GRAY cases use 4,096 levels. Preset tolerances were 2×10⁻⁶ for analytic cases and 8×10⁻⁵ for the sampled curve. The wider table tolerance reflects the already observed LCMS UInt16 table input/output rounding, while OpenLR interpolates the stored table continuously. Thresholds were not loosened after these PNG runs. These are synthetic numerical tests; they do not establish other platforms, HDR, general ICC, memory/performance or all malformed PNGs.

```powershell
node scripts/experiments/png-input-color.mjs
node --test tests/png-color.test.js tests/icc-input.test.js tests/color-profile.test.js tests/color-spaces.test.js
# OPENLR_LIBPNG_LIBRARY / OPENLR_LCMS_LIBRARY can select native tools.
# OPENLR_CMS_PYTHON selects Python. OPENLR_TEST_CMS=1 requires native validation.
```

Missing optional tools cause a clear skip in the test, or failure when required; an explicitly configured broken tool path fails. The focused PNG color suite additionally checks precedence, exact gamma direction, arbitrary white adaptation, partial/absent metadata assumptions, signed P3 output, all supported GRAY curve families, alpha, unsupported characterization, damaged-palette diagnostics and provenance. Browser/GUI source ownership, EXIF orientation, persistence and exported pixels require the separate integration suites.
