# Named RGB output transform: implementation and independent experiment

Executed 2026-11-05 on Windows x64, Node.js v24 and Python 3.14. This records the implemented fixed-space color core in `web/color-spaces.js`, independent CMS measurements, and their limits. The earlier [color management investigation](color-management.md) remains a record of the prior baseline and proposals. This experiment makes no claim about Lightroom's exported pixels or ICC profiles.

## Contract and chosen implementation

`COLOR_SPACES` owns five IDs with labels: `srgb`, `display-p3`, `adobe-rgb`, `prophoto-rgb`, and `rec2020`. `convertSrgbPixels({data,width,height},target)` accepts tightly packed unassociated 8-bit sRGB RGBA, returns a new `{data,width,height}` with `Uint8ClampedArray` pixels, and copies alpha exactly. It never modifies input bytes. sRGB identity is byte exact. Target encoding is applied once followed by component clipping to [0,1] and nearest-integer 8-bit quantization. There is no image-size policy ceiling.

`convertRgbColor(rgb,source,target)` converts normalized encoded floating RGB without clipping or quantization. Signed transfer-function extension retains negative and greater-than-one values. `convertLinearSrgbColor(rgb,target)` starts with linear-light sRGB floats and returns encoded target floats, allowing higher-precision callers to perform their single final quantization. These functions do not make the existing sRGB editing pipeline a wide-gamut pipeline.

`makeColorProfile(target)` returns deterministic, independently generated ICC v4.3 bytes describing the same matrix/TRC space. Profiles have RGB device space, XYZ PCS, display class, relative-colorimetric header intent, localized description/copyright, D50 media white, Bradford chromatic-adaptation matrix, D50-adapted colorant columns, and three parametric tone curves. No profile asset is loaded or copied. All tag starts are aligned to four bytes. Profile header dates are a fixed implementation date for deterministic bytes; they do not represent the photograph's capture date.

| ID | Primaries (x,y), red / green / blue | White | Encoded-to-linear curve |
| --- | --- | --- | --- |
| `srgb` | (.64,.33) / (.30,.60) / (.15,.06) | D65 | sRGB piecewise, threshold .04045, slope 1/12.92, exponent 2.4 |
| `display-p3` | (.68,.32) / (.265,.69) / (.15,.06) | D65 | Same as sRGB |
| `adobe-rgb` | (.64,.33) / (.21,.71) / (.15,.06) | D65 | Exponent 563/256 |
| `prophoto-rgb` | (.734699,.265301) / (.159597,.840403) / (.036598,.000105) | D50 | Linear /16 at and below 1/32, exponent 1.8 above |
| `rec2020` | (.708,.292) / (.170,.797) / (.131,.046) | D65 | Exponent 2.4, full-range SDR display encoding |

D65 uses x=.3127, y=.3290. All spaces connect through the exact ICC PCS header illuminant X=0xf6d6/65536, Y=1, Z=0xd32d/65536. The ProPhoto matrix is generated for that same D50 rather than mixing a chromaticity-rounded CSS D50 with an ICC-rounded PCS D50. Native-white RGB colorant matrices are derived from the tabulated primary chromaticities and white using linear algebra; D65 spaces then use Bradford adaptation to the common D50. ICC colorants, adaptation coefficients and parametric coefficients are rounded to s15Fixed16 only during profile serialization. Full-precision JS conversion retains the unrounded matrices.

Display P3 uses D65 and the sRGB curve; it is distinct from DCI-P3. Rec.2020 is explicitly gamma 2.4 SDR, with zero black lift and unit gain, following the selected W3C definition; it is neither the BT.2020 broadcast OETF nor PQ/HLG. These definitions and the ProPhoto toe come from [W3C CSS Color 4, fixed 2026-11-03 draft, sections 10.2–10.8](https://www.w3.org/TR/2026/CRD-css-color-4-20261103/#predefined). ICC layout, parametricCurveType, matrix profiles and D50 requirements come from [ICC.1:2022](https://www.color.org/specification/ICC.1-2022-05.pdf). The code independently implements the mathematics; no W3C sample source, Adobe profile, Adobe program, or proprietary asset is imported.

The choice is a small fixed-space matrix/TRC domain implementation: this output requirement needs five known spaces and benefits from a shared, dependency-free transform usable by browser and CLI export. A general Little CMS/skcms runtime remains an alternative when arbitrary input ICC, CMYK, LUT profiles, perceptual mapping, black-point compensation or soft proofing is required. Generated matrix profiles and explicit component clipping do not implement those capabilities. Encoding current sRGB pixels into a larger target space preserves their appearance; it does not restore lost source gamut, precision, or sensor dynamic range. Native display management and HDR output remain separate responsibilities.

## Independent CMS procedure

The test embeds Python validation code in `tests/color-spaces.test.js`; generated fixture data is passed over standard input and never uses personal photographs. The only integration tool is **Pillow 12.0.0**, whose Windows CPython 3.14 wheel exposes **Little CMS 2.17** through ImageCms. Pillow was installed in ignored `.tools/color-cms`; it is not an application or Node dependency and no lockfile was changed. Pillow retains its MIT-CMU license in the tool installation. Its bundled LCMS is MIT licensed; upstream [Pillow 12.0.0 source/license](https://github.com/python-pillow/Pillow/tree/12.0.0) and [LCMS 2.17 source/license](https://github.com/mm2/Little-CMS/tree/lcms2.17) are the provenance references for this validation tool. Context7 `/mm2/little-cms` was queried for profile, parametric-curve, transform, relative intent and no-optimization API discovery; the [LCMS public header](https://github.com/mm2/Little-CMS/blob/lcms2.17/include/lcms2.h) and real ImageCms execution establish the actual API behavior used here.

Each run generates **5,265 colors**: 17³ RGB cube points rounded to 8-bit, all 256 neutral values, and 96 near-black primary-axis values (0–31 for each channel). It opens every generated ICC in LCMS, checks RGB/XYZ matrix-shaper interpretation, and runs relative-colorimetric transforms with optimization disabled and black-point compensation absent. There are two source references: OpenLR's generated sRGB profile, and LCMS's independently created built-in sRGB profile. Both transform into the generated target profiles; their quantized RGB results are compared with OpenLR. A separate JS test covers every alpha byte, immutable input, encoded and linear float APIs, unbounded float roundtrips, black/white/neutral axes, metadata/tag bounds, and exact byte identity for sRGB.

The appearance ablation uses an independent built-in LCMS sRGB source and built-in Lab destination. For each target, it compares (1) original source Lab, (2) converted bytes interpreted with the target ICC, and (3) unchanged sRGB numbers interpreted with only the target ICC. Pillow's Lab transport is 8-bit; L is scaled from [0,255] to [0,100], and a/b have the same transport offset removed. Reported ΔE76 includes Lab quantization and 8-bit RGB output quantization. These are not full-precision XYZ or high-precision perceptual error measurements.

Initial thresholds fixed before the run were ≤1 RGB byte per channel for both source profiles, corrected mean ΔE76<1.5, and label-only mean ΔE76>3 for every non-sRGB target. The first independent test **failed** the generated-source Adobe RGB case: pure blue [0,0,207] became [2,0,202] in LCMS versus [0,0,202] in the unrounded transform. Further examples were [0,0,223]→[2,0,218] versus [0,0,218] and [0,0,239]→[2,0,234] versus [0,0,234]. Separate s15Fixed16 rounding of two colorant matrices introduces a small positive red component at this theoretical zero; the gamma curve expands the near-black difference. The independently created built-in sRGB profile stays within 1 for this same target. The test therefore records and permits **2 only for generated-sRGB→generated-Adobe RGB**, keeping ≤1 for every other combination. This is a disclosed precision limit, not a claim that the original threshold passed.

## Measured results

All five profiles parsed and all four tests passed after the stated, narrowly scoped precision criterion change. Every alpha value was unchanged. These measurements are from one Windows/Pillow/LCMS version; they do not prove all native WebViews or image encoders honor embedded profiles.

| Target | Max RGB byte difference: generated sRGB / built-in sRGB | Mean ΔE76 converted + ICC | P99 ΔE76 | Max ΔE76 | Mean ΔE76 label only |
| --- | --- | --- | --- | --- | --- |
| sRGB | 0 / 0 | .00307 | 0 | 1 | .00307 |
| Display P3 | 1 / 1 | .34702 | 1.41421 | 1.46758 | 10.37920 |
| Adobe RGB | 2 / 1 | .35279 | 1.41421 | 1.46758 | 12.97596 |
| ProPhoto RGB | 1 / 1 | .48185 | 1.46758 | 2.27020 | 37.73318 |
| Rec.2020 gamma 2.4 SDR | 1 / 1 | .43268 | 1.41421 | 1.46758 | 26.91395 |

The ablation separates genuine pixel conversion from label substitution: the latter produces much larger independently measured appearance errors for every non-sRGB target. The small nonzero sRGB Lab error is the generated profile versus LCMS built-in sRGB rounded-profile difference at Lab8 precision; the RGB conversion identity itself is exact.

## Reproduction and remaining checks

```powershell
# Optional independent validation tooling, outside application dependencies:
python -m pip install --target .tools/color-cms Pillow==12.0.0
$env:OPENLR_TEST_CMS = '1'
node --test tests/color-spaces.test.js
```

With `OPENLR_TEST_CMS=1`, missing Pillow/Python fails the check. Ordinary tests explicitly skip the independent CMS integration if Pillow is unavailable; that skip must not be reported as an independent pass. `OPENLR_CMS_PYTHON` can point to the chosen Python executable. The JS color/profile tests do not require Python. The test prints the measured version, sample count, and actual metrics on every CMS run.

No general input-profile handling, float LCMS/XYZ comparison, wide-gamut RAW preservation, visual native display evaluation, throughput benchmark, or comparison against actual Lightroom export is claimed by this experiment. The generated profiles' on-disk embedding and format roundtrips are owned by the export/container integration checks. High-precision callers must retain floating pixels before final encoding; multiplying an 8-bit value by 257 does not demonstrate preserved 16-bit source precision.
