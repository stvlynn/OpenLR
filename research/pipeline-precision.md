# Processing precision measurements

Measured on 2026-11-05, Windows/Chrome 155. Baseline renderer: `b8b9bab`.
This is a generated-image experiment and migration evidence, not a claim that
OpenLR now provides high-precision editing or Adobe-identical processing.

## Sources and scope

REA `inspect_pe_resources` re-read the installed Lightroom 9.4
`Develop.lrmodule`: complete bounded resource tree, 395 entries / 195 resources,
evidence `ev_cbea8addf38164e3b033afae01421e83a8ee34194c819f291be4525bd6f399e3`.
It confirms histogram/point-color resources at the same ranges recorded in
[the Lightroom ledger](lightroom.md). A focused Lua constant search for `HDR`
in the histogram resource returned no matching literal instruction; this does
not establish absence of HDR logic. The installed translation table separately
contains HDR edit mode, one-to-four-stop range, and HDR export-space entries.
Neither resource observation establishes Adobe's internal arithmetic or gamut.
No proprietary resource was copied into OpenLR.

Independent implementation guidance comes from the
[darktable processing documentation](https://darktable-org.github.io/dtdocs/en/overview/workflow/process/),
which separates unbounded linear processing from final display compression, and
[its pipeline discussion](https://docs.darktable.org/usermanual/4.2/en/special-topics/color-pipeline/),
which explains why bounded masks and blend modes require migration too.
Context7 `/academysoftwarefoundation/opencolorio` supplied the official
[display-view examples](https://github.com/AcademySoftwareFoundation/OpenColorIO/blob/main/docs/guides/developing/usage_examples.rst)
and [negative-value transform notes](https://github.com/AcademySoftwareFoundation/OpenColorIO/blob/main/docs/releases/ocio_2_5.rst).
These support explicit processing/display boundaries; no external renderer code
or OpenColorIO dependency is introduced.

## Actual existing renderer

`node scripts/experiments/pipeline-precision.mjs` runs the real `render()` in
Chrome on an opaque 256×32 neutral ramp. A full-coverage radial mask applies
+4 EV; global exposure applies −4 EV. In an unbounded linear exposure-only
chain these operations cancel. The current local adapter clips before the
global operation: 256 input levels become **72**, maximum byte error **184**.
Inputs 128, 192 and 255 all return 71. This is observed application behavior,
not a hypothetical loss estimated from array types.

This experiment intentionally remains separate from ordinary regression tests:
its assertion exposes the old limitation and must change when the complete
renderer migrates. It is not a requirement to preserve that limitation.

## Storage ablation

The same script evaluates 65,536 uniformly spaced linear components from −0.25
through 16, storing after input, +4 EV and −4 EV. Inputs include out-of-gamut
matrix components and values above display white. Native `Math.f16round`,
`Math.fround`, and double arithmetic supply the floating alternatives;
UNORM alternatives explicitly clip/quantize. This is a numerical exposure
experiment, not an implemented replacement renderer or a performance benchmark.

| Storage | Maximum absolute error | Distinct output levels |
| --- | ---: | ---: |
| UNORM8 | 15.93725490196 | 17 |
| UNORM16 | 15.93749904631 | 254 |
| Float16 | 0.003905951972 | 8,146 |
| Float32 | 4.768007784e-7 | 65,536 |
| Float64 | 0 | 65,536 |

No alternative produced a non-finite value. The script's Float32 hypothesis
requires maximum error below `1e-6` and all 65,536 distinct outputs, and passes.
Float16 exceeds `1e-3`; more bits in bounded UNORM16 do not fix clipping.
Float32 is therefore the supported CPU working-buffer candidate for the next
implementation. This does not prove every operator's stability or performance,
or prohibit Float16 for a separately validated display/GPU cache.

## Concrete correction from RAW investigation

The separate [real LibRaw experiment](high-precision-raw.md) found that ordinary
RAW decoding left LibRaw's default BT.709 transfer in place while treating its
output as standard sRGB. The fix makes both bitmap and linear-frame routes
decode 16-bit linear sRGB with unit gamma, then applies the shared standard sRGB
transfer only to the 8-bit display buffer. It preserves the existing linear
DNG/HDR numerical contract and avoids changing their calibration.

`tests/raw.test.js` compares every displayed RGB sample with the independently
evaluated sRGB transfer of actual linear RAW samples, and checks the linear
preview against ordinary decode. Both measured errors are zero on its generated
sensor fixture. RAW/DNG/HDR/fallback checks pass. This corrects a transfer
mismatch; the normal editor still consumes an 8-bit bitmap and LibRaw still
clips its 16-bit processed RGB output. Existing RAW appearances may change
because the previous base used the wrong transfer; original bytes and recipe
values are unchanged.

The [full pipeline audit](precision-pipeline-audit.md) identifies remaining
quantization in all local/global edits, geometry, codecs, derived assets and
storage. A high-depth export-only shortcut is not the planned end state. The
next implementation must retain explicit frame color/alpha/sample semantics
through the complete shared renderer, version legacy recipe behavior, and make
display conversion terminal. Existing DNG/HDR contracts need explicit adapters.
