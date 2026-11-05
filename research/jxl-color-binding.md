# JPEG XL input-profile binding experiment

This record owns the source-level rationale and repeatable binding experiment.
It is separate from the export product contract in [output color](../docs/export-color.md).
The experiment uses generated pixels and OpenLR-generated matrix/TRC profiles;
no Adobe profile, catalog, program, or personal photograph is used.

## Fixed source evidence

Primary GitHub connector inspection confirmed that the published jSquash JXL
1.3.0 source at [`1b1964194611ece3ec984ab91c04726d1088f05e`](https://github.com/jamsinclair/jSquash/tree/1b1964194611ece3ec984ab91c04726d1088f05e/packages/jxl)
uses the internal libjxl `ConvertFromExternal` API with hardcoded
`ColorEncoding::SRGB`, 8-bit integer input and straight RGBA. Its
[Makefile](https://github.com/jamsinclair/jSquash/blob/1b1964194611ece3ec984ab91c04726d1088f05e/packages/jxl/codec/Makefile)
pins libjxl `9f544641ec83f6abd9da598bdd08178ee8a003e0` (0.7.0-era code).
The existing decoder queries the data ICC and uses skcms to return sRGB.

The fixed libjxl public [encoding header](https://github.com/libjxl/libjxl/blob/9f544641ec83f6abd9da598bdd08178ee8a003e0/lib/include/jxl/encode.h)
defines `JxlEncoderSetICCProfile`, `JxlEncoderSetBasicInfo`,
`JxlEncoderAddImageFrame`, lossless mode and frame distance. Crucially,
`uses_original_profile=false` makes unsigned integer input **sRGB**, even if an
original ICC profile has been set. Already-converted target RGB bytes require
`uses_original_profile=true`. The latter also makes decoded data use the
original profile, as described by the fixed
[basic-info contract](https://github.com/libjxl/libjxl/blob/9f544641ec83f6abd9da598bdd08178ee8a003e0/lib/include/jxl/codestream_header.h).

Setting only an ICC on an already-created codestream is therefore insufficient:
the encoder must consume those target-space samples under that profile contract.
The new original OpenLR wrapper calls the public API before encoding. It does
not patch JXL codestream bits or change a finished file's label.

## Sources and terms

The build uses the same libjxl revision as the currently packaged runtime.
The canonical fixed source archive URLs and commits are recorded in
[sources.json](../scripts/codec-color/jxl/sources.json); the fetcher reads that
file and writes actual downloaded byte counts into the ignored tooling receipt.
Brotli, Highway and
skcms revisions are the libjxl gitlinks, not current upstream branches. libpng
and zlib sources are configure-time requirements of this old libjxl CMake
configuration; the binding does not use their raster codecs.

The OpenLR C++ wrappers, fetch script, CMake file and experiment are independently
written project source. No jSquash C++ source was copied. libjxl and skcms use
their retained BSD-style notices; Brotli uses MIT; Highway uses Apache-2.0.
Existing complete component notices in `web/vendor/codecs/notices/` remain
required for runtime distribution, together with Emscripten's license. Public
source archives are fetched to ignored `.tools/`; the tooling does not install
an SDK or invoke package managers. No additional hash acceptance gate is used.

## Reproduction

Activate Emscripten 3.1.64 and provide CMake >=3.20, Ninja and Python 3. The
`build.sh` source download step needs network access once; subsequent runs reuse
fixed local archives. From a Linux shell (including WSL at the repository root):

```sh
bash scripts/codec-color/jxl/build.sh
OPENLR_JXL_VARIANT=mt bash scripts/codec-color/jxl/build.sh
OPENLR_JXL_VARIANT=mt_simd bash scripts/codec-color/jxl/build.sh
```

The build produces `.tools/codec-color/jxl/build/jxl_color_enc.js` / `.wasm` and
a separate validation-only `jxl_inspect.js` / `.wasm`. The inspector uses public
libjxl decoder APIs to return original ICC, actual data ICC, bit depth, alpha
metadata and literal decoded RGBA bytes. It performs no skcms transformation.
Run the generated-image experiment from the repository root using Node 24:

```sh
# Rebuild scalar with the mode-control binding enabled for this experiment only:
OPENLR_JXL_EXPERIMENTS=ON bash scripts/codec-color/jxl/build.sh
node scripts/codec-color/jxl/experiment.mjs
# With Pillow 12.0.0 installed as described by the transform experiment:
# PowerShell: $env:PYTHONPATH = '.tools/color-cms'
python scripts/codec-color/jxl/cms_check.py
# Restore the production binding before packaging or browser variant validation:
bash scripts/codec-color/jxl/build.sh
node scripts/codec-color/jxl/browser_check.mjs
```

The experiment encodes a generated 256×192 RGBA image into five profiles at
quality 100/lossless and quality 80/lossy, comparing profile-preserving VarDCT
and modular encoding. Libjxl's true lossless setting overrides the requested
compression mode, so the meaningful mode comparison is at quality 80. It records
wall time, file bytes, maximum and mean RGB
sample error and maximum alpha error. It requires exact lossless samples/alpha
and real metadata/sample decoding, and rejects malformed ICC and corrupt JXL.
Files, extracted profiles, literal RGBA and a JSON report stay in ignored
`.tools/codec-color/jxl/experiment/`.

The pinned public frame-distance API also adjusts extra-channel quantization;
lossy alpha is measured rather than advertised as byte exact. Quality 100 uses
`JxlEncoderSetFrameLossless`, not merely a low distance. Profile byte identity
is measured but cannot by itself establish correctness: libjxl may represent a
known ICC as structured color fields and regenerate a semantically matching
profile. Both ICC interpretations and decoded sample colors need inspection.

## Executed scalar result

Executed 2026-11-05: Windows x64 / WSL Ubuntu 24.04 build, Emscripten 3.1.64,
CMake 3.31.6, Ninja 1.11.1; generated WASM exercised in Windows Node 24.9.0.
The first configure/generate took 117.1/7.3 seconds, and the Ninja log reports
177.568 seconds for 171 compile/link tasks with four build jobs. The first
scalar encoder is 2,068,985 WASM bytes plus 38,774 JS bytes; validation-only
inspector is 790,431 WASM bytes plus 35,026 JS bytes. Subsequent wrapper changes
and the parallel/SIMD variants are tracked separately below.

All **20 actual JXL files** decoded successfully. All five lossless outputs
returned byte-exact target RGB and alpha; both the original ICC and actual data
ICC were byte-exact copies of the intended generated profile in these files.
Both quality-zero endpoints encoded, and corrupt JXL/malformed ICC were
rejected. No source pixel buffer was relabeled after encoding.

Pillow 12.0.0 / Little CMS 2.17 independently parsed each extracted data ICC
and transformed literal decoded RGB into its independently generated sRGB.
The following lossless measurements include the existing target-space 8-bit
quantization; exact target-sample compression does not imply an exact sRGB
round trip, especially for saturated/near-black source values.

| Target | Lossless file bytes | Mean / P99 / max sRGB byte error | Mean error with label-only negative control |
| --- | ---: | --- | ---: |
| sRGB | 8,876 | 0 / 0 / 0 | 0 |
| Display P3 | 26,457 | .223 / 2 / 9 | 11.571 |
| Adobe RGB | 22,046 | .247 / 3 / 12 | 12.043 |
| ProPhoto RGB | 35,517 | .535 / 5 / 18 | 26.702 |
| Rec.2020 gamma 2.4 | 32,977 | .447 / 4 / 18 | 22.107 |

The synthetic blue channel changes rapidly between neighboring pixels; this
deliberately stresses lossy encoding and is not a representative photograph.
At quality 80, the following VarDCT/modular comparison uses the same target
profile contract (`uses_original_profile=true`) for both modes. Times are
single observed encodes, not throughput benchmarks or medians.

| Target | VarDCT / modular bytes | VarDCT / modular ms | CMS mean sRGB error, VarDCT / modular |
| --- | --- | --- | --- |
| sRGB | 6,959 / 14,179 | 80.34 / 54.56 | 6.256 / 6.031 |
| Display P3 | 7,021 / 16,847 | 76.30 / 54.40 | 7.439 / 7.696 |
| Adobe RGB | 7,092 / 17,924 | 66.11 / 52.23 | 7.269 / 6.587 |
| ProPhoto RGB | 14,174 / 15,380 | 82.04 / 51.88 | 12.794 / 10.134 |
| Rec.2020 gamma 2.4 | 9,621 / 15,768 | 74.29 / 46.72 | 9.454 / 9.445 |

Modular reduced the maximum/P99 RGB error in this high-frequency image and was
faster, while VarDCT made smaller files. Both lossy modes had a maximum alpha
error of 5; neither is advertised as preserving lossy alpha. The complete
raw-sample errors, file sizes, times and CMS metrics are reproducible in the
ignored JSON outputs. This experiment does not demonstrate a universal quality
advantage for either mode and does not validate native WebView display behavior.

## Parallel variants

The same wrapper now has `OPENLR_THREADS` and `OPENLR_SIMD` CMake options;
`build.sh` selects separate build directories. The threaded build links
`jxl_threads-static` and actually installs a `JxlThreadParallelRunner` on the
encoder. Pool size and runner worker count use host hardware concurrency, as
the former packaged implementation did. Build feature introspection reports
the actual compile-time threading/SIMD flags and public libjxl version. The
inspector is built only in the scalar directory and is not a runtime asset.

Final production builds completed with exit code zero for all three variants.
Initial complete threaded/parallel-SIMD Ninja runs took 242.655/242.691 seconds
with four jobs per build, including concurrent compilation on the same host.
These are workspace-on-Windows/WSL timings, not portable throughput claims.
Reconfiguration and the final wrapper-only incremental rebuilds then produced:

| Variant | JavaScript bytes | WASM bytes | Worker loader bytes |
| --- | ---: | ---: | ---: |
| Scalar | 39,270 | 2,069,440 | — |
| pthread | 56,793 | 2,139,367 | 294 |
| pthread + SIMD | 56,808 | 2,347,781 | 294 |

Threaded output filenames are `jxl_color_enc_mt.{js,wasm}` and
`jxl_color_enc_mt.worker.mjs`; SIMD filenames add `_simd` before the extension
and before `.worker.mjs`. Emscripten 3.1.64 emits module worker loaders with an
`.mjs` suffix. The CMake `OUTPUT_NAME` owns these paths so generated glue
references its matching WASM and worker without post-build renaming.

`node scripts/codec-color/jxl/browser_check.mjs` passed in **Chrome
155.0.8059.39** with real cross-origin isolation. Each variant encoded and
decoded five spaces at both lossless and lossy quality, totaling **30 actual
files**. All lossless RGBA bytes were exact; all non-sRGB data ICC profiles
matched their requested target. Introspection returned libjxl version 7000
(0.7.0), correct compile-time threading/SIMD flags and no experimental API.
Both threaded variants actually started **16 Worker instances**. This checks
real browser pthread execution, rather than only validating Node's scalar
module. The ignored `browser-results.json` retains the detailed observations.
The final test-only API build also reran all 20 scalar mode/profile cases
successfully before rebuilding production with its experimental entry disabled.

These are codec-module checks. Product GUI/CLI routing, ordinary Worker startup
fallback and the actual native WebView remain owned by the integration checks;
their success cannot be inferred solely from this record.

Production `encodeColor(data,width,height,icc,quality,lossless,effort,inputIsSrgb)`
uses VarDCT for lossy output. It keeps the original profile for every non-sRGB
target and for all lossless output. Only explicitly sRGB lossy input uses XYB
with `uses_original_profile=false`, preserving the previous default's input
meaning and compression strategy. The comparative mode control is a separate
test-only entry enabled by `OPENLR_JXL_EXPERIMENTS`; normal builds omit it.
