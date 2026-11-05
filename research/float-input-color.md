# Float input color: matrix/TRC evidence and implementation boundary

Investigated and implemented 2026-11-05 on Windows x64, Node.js 24.9.0 and Python 3.14. This records source evidence, independent measurements and the deliberately bounded shared input transform. It does not establish that every codec or ICC profile works. The [linear frame contract](../docs/linear-working-frames.md) owns codec integration behavior; the [output transform experiment](color-transform-experiment.md) owns the existing named-space mathematics.

## Existing implementation and recommended reuse

`web/color-profile.js` validates an RGB ICC container and known curve/XYZ payload layouts. It explicitly does not interpret LUT internals. Its success cannot authorize a matrix transform: it accepts Lab PCS and unknown LUT tags, and does not require all six RGB matrix/TRC tags. `web/color-spaces.js` already owns the five named spaces, signed named-space curves, D50-adapted matrices, and export profiles. Reuse that owner's matrix multiplication and its existing linear-sRGB inverse through a small public conversion primitive. Do not copy the sRGB primary definitions, Bradford calculation, or a second fixed-space engine into each codec.

`web/icc-input.js` parses structurally validated RGB matrix/TRC input into three forward tone curves and a D50 XYZ matrix, then evaluates `linear sRGB = existing sRGB.fromXYZ × input matrix × decoded channels`. `matrixToLinearSrgb` in the existing color-space owner composes those matrices; the validator and interpreter share `evaluateParametricCurve`. All intermediate arithmetic is float. Matrix results may be negative or above one and survive into the existing Float32 working frame. This needs neither an encoded-sRGB intermediate nor a canvas.

The implementation requires RGB device space, XYZ PCS, input/display class, the three `rXYZ/gXYZ/bXYZ` columns and `rTRC/gTRC/bTRC` curves, and a finite nonsingular matrix. It returns an unsupported reason for profiles with device-to-PCS LUT tags (`A2B0/1/2`, `D2B0/1/2/3`) instead of silently substituting its matrix for a selected LUT. `cicp`/`arts` profile interpretation and other profile classes are unsupported. Unknown descriptive metadata is not itself a transform. Codec adapters own visible failure or documented display-decoder fallback with honest precision provenance.

This precedence concern is demonstrated by [Little CMS 2.17 input-pipeline source](https://github.com/mm2/Little-CMS/blob/lcms2.17/src/cmsio1.c): it selects floating/ordinary intent tables before its matrix-shaper fallback. Structural validation alone cannot replicate that selection.

## Curve and PCS rules from primary specifications

The official [ICC v2 specification, ICC.1:2001-04, section 6.5.3](https://archive.color.org/files/ICC_Minor_Revision_for_Web.pdf) defines `curveType` (`curv`). The [ICC v4 specification, ICC.1:2022, sections 10.6 and 10.18](https://www.color.org/specification/ICC.1-2022-05.pdf) defines `curv` and `parametricCurveType` (`para`). A v2 header with `para` is not standard v2 conformance, even when a permissive CMS reads it. The implemented subset returns `profile-v2-parametric` for this combination.

- `curv` count 0 is identity. Count 1 is canonical forward gamma, with `g = stored UInt16 / 256`, so `Y = X^g`, not its inverse. Count greater than 1 stores UInt16 outputs normalized by 65535 at uniform input positions `i/(n−1)`; interpolate linearly between adjacent entries. The finite unsigned input domain is [0,1]. Do not replace this interpolation with a 256-entry byte table.
- `para` coefficients are signed s15Fixed16 integers divided by 65536; they are not IEEE Float32. Function type numbers are the ICC on-disk numbers below. Little CMS's public curve-construction API numbers these functions 1 through 5, one greater than the ICC payload numbers.

| ICC type | Parameters in payload order | Forward curve |
| --- | --- | --- |
| 0 | g | `X^g` |
| 1 | g,a,b | `(aX+b)^g` if `X ≥ −b/a`, otherwise `0` |
| 2 | g,a,b,c | `(aX+b)^g+c` if `X ≥ −b/a`, otherwise `c` |
| 3 | g,a,b,c,d | `(aX+b)^g` if `X ≥ d`, otherwise `cX` |
| 4 | g,a,b,c,d,e,f | `(aX+b)^g+e` if `X ≥ d`, otherwise `cX+f` |

These expressions follow ICC.1:2022 table 68, including its correction of older table versions. Validate the active [0,1] domain, branch boundary and real power base before processing pixels. Do not invent a signed power extension for arbitrary ICC curves. Nonmonotone tables may be evaluated forward without inversion, but are not evidence of a well-characterized photographic profile; rejecting them is a declared subset restriction, not an ICC parsing necessity.

RGB matrix columns are already PCS-relative D50 XYZ. `XYZType` coefficients use signed fixed-point /65536 and correspond to physical relative tristimulus values with white Y=1. They are not normalized 16-bit LUT PCS samples: the latter encode Y=1 as 0x8000. Do not divide the colorant matrix by two, multiply by 65535/32768, or apply `chad` a second time. `chad` records adaptation from the adopted source white to PCS white; its presence explains how the stored colorants reached D50. ICC v4 sections 6.3.4, 9.2.15 and annex E describe those distinctions. Little CMS's internal `InpAdj` is paired with its packed-PCS machinery; copying it into a direct XYZ float calculation would introduce a scale error.

Older v2 media-white/adaptation conventions require care. In the tested relative-colorimetric matrix path, LCMS reads the stored colorant columns directly; its v2 display-white and missing-`chad` compatibility adjustments belong to its separate media-white/adaptation handling. This does not validate every historical v2 profile or absolute-colorimetric conversion. A first implementation should specify relative colorimetric, no black-point compensation, and no perceptual gamut mapping.

## Independent float measurements

Installed Pillow 12.0.0 exposes LCMS 2.17 through ImageCms but does not expose a general three-channel Float32 RGB transform in this installation. Its `_imagingcms` extension also does not export the LCMS C symbols. Reusing the existing Pillow RGB8 experiment would therefore not establish preserved high-depth input.

An already installed ignored Playwright WebKit dependency, `.tools/pw-browsers/webkit-2215/lcms2-2.dll`, exposes LCMS C symbols and reports encoded version **2170**. An original ignored experiment, `.tools/float-icc-research.mjs`, calls those symbols through Python `ctypes`. It uses `cmsOpenProfileFromMem`, `cmsCreateXYZProfile`, `cmsCreateTransform(TYPE_RGB_FLT, TYPE_XYZ_FLT, INTENT_RELATIVE_COLORIMETRIC, NOOPTIMIZE|NOCACHE)` and `cmsDoTransform`; BPC is absent. Public constants and signatures were checked against the [2.17 header](https://github.com/mm2/Little-CMS/blob/lcms2.17/include/lcms2.h). Context7 `/mm2/little-cms` was consulted for API discovery, then pinned source and actual execution established the tested behavior. Context7 returned some newer 2.19 documentation, so it was not used to claim installed-version behavior.

Each profile received **10,557 normalized Float32 RGB inputs**: a 17³ cube, 4,096 grays, 513 low Uint16 values on each primary axis, and nine near-branch samples. Expected XYZ was computed independently from the actual serialized fixed-point colorants and curve coefficients, avoiding confusion between profile rounding and an unrounded named-space definition. Profiles were the five generated named profiles plus original synthetic curve fixtures: identity, gamma, a five-point table, and parametric types 0–4. The synthetic fixtures were also run with v2 and v4 header variants; accepted v2 parametric combinations are CMS permissiveness evidence only. Their other header/tag metadata was not rebuilt into conformance fixtures.

| Input profile/curve | Maximum absolute D50 XYZ channel difference |
| --- | --- |
| Five generated named profiles | ≤8.290 × 10⁻⁸ |
| Identity (`curv` count 0) | 5.948 × 10⁻⁸ |
| Gamma (`curv` count 1) | 8.131 × 10⁻⁸ |
| Parametric types 0–4 | ≤8.765 × 10⁻⁸ |
| Five-point sampled curve | 2.200 × 10⁻⁵ |

The sampled-curve discrepancy is expected from the actual [LCMS 2.17 `cmsEvalToneCurveFloat` implementation](https://github.com/mm2/Little-CMS/blob/lcms2.17/src/cmsgamma.c): for an ordinary 16-bit sampled curve it first quantizes input to UInt16, evaluates the UInt16 table, then divides the UInt16 output by 65535. The independent expected calculation instead performs the specification's linear interpolation continuously. It is inappropriate to claim all float CMM stages have unlimited precision merely because their external type is float. A maintained regression should set separate table/parametric tolerances based on this recorded difference, with explicit assertions; this exploratory script reports measurements rather than acting as a quality gate.

The experiment also sent `[-0.25, 1.25, 0.5]`. Identity preserves its negative input, gamma 2.2 clamps the negative input to zero, sRGB type 3 takes its linear lower branch, and sampled curves bound their domain to endpoint values. Positive parametric highlights can exceed one. This agrees with the curve-dependent behavior visible in pinned `cmsgamma.c` and the [CLUT/interpolation source](https://github.com/mm2/Little-CMS/blob/lcms2.17/src/cmsintrp.c). It differs from the existing named-space core's deliberate sign-reflected transfer-function extension. Therefore the initial generic ICC API should consume normalized unsigned source samples; it should not promise arbitrary signed encoded ICC inputs. Negative or high linear RGB generated after the source transform is retained unchanged by later float stages.

The maintained experiment now compares the implemented Float32 linear-sRGB output against independently interpreted LCMS XYZ followed by the existing core's D50-XYZ-to-linear-sRGB matrix. It uses **16 supported profiles**; v2 parametric variants are excluded from the supported regression. The original XYZ-only exploratory measurements above isolate source-profile interpretation. The maintained check tests the implementation, with separate preset tolerances of **5 × 10⁻⁷** for analytic/identity curves and **8 × 10⁻⁵** for sampled curves. It ran successfully against both explicitly selected LCMS **2.17** and automatically discovered native LCMS **2.19**: maximum linear-sRGB channel error was **3.1461 × 10⁻⁷** for analytic curves and **2.2009 × 10⁻⁵** for tables in both runs. This shares the already validated target-space matrix with the reference calculation; it is an independent source-ICC interpreter comparison, not a second independent derivation of sRGB colorimetry.

Portable reproduction:

```powershell
node scripts/experiments/icc-input.mjs
node --test tests/icc-input.test.js tests/color-profile.test.js tests/color-spaces.test.js
# Optional: OPENLR_LCMS_LIBRARY selects a native LCMS library.
# OPENLR_CMS_PYTHON selects Python; OPENLR_TEST_CMS=1 requires CMS validation.
```

The Node runner invokes the original Python ctypes adapter, discovers system LCMS or an existing ignored Playwright WebKit DLL, and prints the actual loaded CMS version and measurements. Missing optional native tooling is a clear skip in the test, or a failure with `OPENLR_TEST_CMS=1`; explicitly configured bad paths are failures. The original exploratory script and results remain ignored under `.tools`. Libraries are validation tools, not shipped dependencies. No external source code or profile asset was imported into OpenLR. The runtime tests additionally cover alpha storage, owned profile bytes, malformed bounds, unsupported LUT precedence and unbounded P3 values. These source-transform measurements do not establish codec decoding, throughput, WASM behavior or other operating systems; those need adapter-level checks.

## TIFF browser and GUI integration measurements

`tests/tiff-input.test.js` adds pure normalized-sample checks across 8/16-bit RGB and gray, strip/tile and both byte orders, associated/unassociated alpha, 16-bit palette entries, explicit packed 1/2/4-bit rows and all eight orientations. Actual Chrome `decodePhotoFrame` exercises a tiled big-endian Deflate/predictor-2 source, keeps 512 distinct low-level values, preserves original bytes, agrees exactly with forced worker-startup fallback and a direct codec call whose `createImageBitmap` bridge is disabled. A generated v4 mAB B-curves-only LUT profile takes explicit `rgba8-display` compatibility with `profile-lut`; malformed ICC and truncated TIFF fail with `CODEC_ERROR`. A captured legacy RGB result remains [3,7,11,255]. These are generated fixtures, not a claim about arbitrary TIFFs.

`tests/high-depth-workflow.test.js` executes the real GUI/shared dispatcher: import a big-endian LZW/predictor-2 TIFF16, select Linear, inspect `state.processing.input` and the visible precision label, export TIFF16, apply local +4/global −4 EV, return to identical legacy pixels, make an exposure edit, export and re-import, restore XMP, and reload the catalog. The initial neutral TIFF16 export exactly matches all original words, retains 512 red levels and sub-byte differences; original-file export remains byte exact. Export/re-import initially **failed an exact-word assertion**: some red words changed by +1, for example 2652→2653. Re-import interprets the serialized ICC's s15Fixed16 curves and matrix, while export uses the unrounded named definition. The criterion was corrected to at most one UInt16 code with all 512 levels retained; the actual measured maximum was **1**. The correction is disclosed rather than calling the original exact criterion a pass. XMP and reload then reproduce the edited TIFF words exactly from the unchanged original. Both suites passed in Chrome on this Windows host; they do not establish other native WebViews.

## Alternatives and shared API

| Route | Benefit | Constraint / evidence needed |
| --- | --- | --- |
| Existing JS color core plus validated ICC matrix/TRC subset | Small dependency-free browser/worker/shared domain path; direct Uint16→Float32; direct signed linear output | Explicit subset, thorough profile bounds/curve checks and visible unsupported results; cannot claim general LUT/CMYK support |
| Little CMS float C API compiled to WASM | Mature profile interpretation, intents, LUT support, same implementation across browser and desktop | New build/runtime/worker boundary, allocation and failure handling, source/license notices and distribution; integer tables/CLUT domains remain bounded. This investigation ran native LCMS, not a WASM build |
| Native OS CMS with 16-bit transport | Potential platform integration | Different adapters on Windows/macOS/Linux; prove true 16-bit input/output and unbounded output before claiming preservation; an integer sRGB destination clips wide colors |
| Browser image/canvas color conversion | Existing display fallback | The [HTML standard](https://html.spec.whatwg.org/multipage/canvas.html#color-spaces-and-color-space-conversion) describes predefined canvas spaces and pixel formats, not a general arbitrary-ICC-byte transform API. Newer float/linear canvas features require capability and real-pixel checks on each WebView. Existing RGBA8 canvas output cannot recover source precision |

The implemented domain entry point is `createProfileToLinearSrgb(profile)`, returning `{kind:'matrix-trc', convert(r,g,b,out,offset=0)}` or `{reason}` for a structurally valid unsupported container. Malformed profiles throw. `convert` takes normalized unsigned encoded components, writes only three linear RGB values into float-capable caller storage, and rejects non-finite or out-of-domain inputs and results exceeding finite Float32 range. `createNamedInputTransform(source='srgb')` in the existing space owner uses the same call shape with its existing named definitions, without an encoded-sRGB roundtrip. An AVIF primary code alone is insufficient to choose a named transfer curve: in particular the existing `rec2020` definition means gamma 2.4, not arbitrary BT.2020 CICP transfer codes.

Codec adapters supply straight RGB/RGBA samples, actual embedded ICC bytes or an explicit characterization, validate dimensions/stride/layout, normalize source words once and allocate an owned tight RGBA Float32 frame. Alpha bypasses color transforms and is normalized once; absent alpha is one. Premultiplied input needs an explicit adapter conversion and zero-alpha policy before color evaluation. Preserve hidden RGB when the decoder provides straight samples. Keep decoded source samples and original file bytes immutable.

Separate unsupported capability from malformed profile errors; record decoder/sample depth, source characterization, transform kind and clipping/precision history in provenance. Profile-less RGB uses the product's documented assumption, not a guessed ICC match. An embedded unsupported profile must not become an unnamed sRGB conversion. Codec workers/fallbacks should call the same shared converter, and asynchronous results remain bound to asset/revision identity. Chunking or memory-pressure failure may be necessary for large images, but no arbitrary file-size ceiling follows from the color model.

## Profiled palette import regression

A post-integration review found that `decode-frame` accepted an RGB-profiled palette TIFF after expanding its 16-bit color map, while the default Original import still rejected photometric 3 at the host-CMS boundary. The shared display adapter now accepts already-expanded palette RGB through the same tagged-PNG CMS bridge. `tests/high-depth-workflow.test.js` exercises real GUI default import, clipped P3-red display, Linear opt-in, target-P3 TIFF16 and unchanged original bytes. Generated palette colors `[65535,0,0]` and `[12345,23456,34567]` exported as `[65535,8,0]` and `[12345,23457,34567]`: a first uniform four-code tolerance failed at the saturated near-zero channel. Serialized ICC s15Fixed16 colorants introduce a small linear residual, amplified by the encoding toe near zero. The test records a sixteen-code bound for that saturated sample and retains four codes for the midtone sample; this is distinct from the earlier one-code sRGB-ramp result, and is not a universal ICC round-trip bound.
