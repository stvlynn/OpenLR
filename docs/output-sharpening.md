# Output sharpening

Export offers **None**, **Low**, **Standard** and **High** for JPEG, PNG, TIFF, AVIF and JPEG XL. The default is None. Output sharpening acts on the final resized photo, before watermark composition and output color conversion. It does not change the photo's Detail sharpening, edit recipe, thumbnail, preview or original file.

```sh
node cli/openlr.mjs export --format image/png --maxSize 1600 --outputSharpening standard --output photo.png
node cli/openlr.mjs export-previous --output next.png
```

GUI, CLI and `export-settings` share validation and successful-output persistence. None is omitted from stored options for compatibility. Cancellation and failed saves keep the previous settings. Non-none requests for originals, original-with-settings, XMP, DNG or video containers fail visibly; the existing still-frame export from video supports the rendered photo formats. Preview never applies this output setting.

## Pixel contract

The optional filter uses an alpha-weighted Gaussian blur of linear-sRGB luminance at the final output dimensions. Its five-tap separable kernel has sigma 0.65 output pixels. Low, Standard and High use gains 0.3, 0.6 and 1, with the added luminance residual limited to ±0.015 times the gain. The same residual is added to RGB; channel differences are preserved before floating-point rounding. This limits added halos without clamping the source RGB range. It is a measured output-size detail filter, not Adobe algorithm equivalence or printer/paper calibration.

Alpha remains unchanged. Invisible neighbors do not contaminate visible colors, and fully transparent hidden RGB remains untouched. Linear processing operates directly on the owned Float32 frame, including negative and above-one samples; TIFF retains its existing 16-bit output path. Original processing converts its already-8-bit canvas through the same linear filter and back to its existing display precision. None keeps both existing encoding routes unchanged. The filter allocates two Float64 scalar planes (16 additional bytes per output pixel), with no fixed photo-size ceiling; browser memory and codec constraints still apply.

`web/export-sharpening.js` owns levels, messages and format validation; `web/output-sharpening.js` owns filtering. The five rendered photo formats have one shared definition used by output color, metadata and sharpening capabilities. The existing recipe sharpening is unchanged because it has a different image-editing responsibility and measured response. See [research and ablation](../research/output-sharpening.md).

## Verification

```sh
node research/output-sharpening-experiment.mjs
node --test tests/output-sharpening.test.js tests/output-sharpening-workflow.test.js tests/export-settings.test.js
node scripts/native-smoke.mjs /path/to/OpenLR
```

Numerical tests compare the separable implementation with independent two-dimensional convolution, check constant and narrow images, alpha, hidden RGB, signed/HDR values, strength order and bounded residuals. Browser tests decode 40 actual outputs across both processing versions and five formats, check default/None byte equality, changed pixels, alpha, ICC, selected copyright and TIFF16 low words, plus settings reuse/reload/cancel and unchanged previews, recipes and originals. A uniform source with text produces identical None/High exports, proving that output sharpening precedes the watermark rather than sharpening its edges.

Native acceptance exports and reimports all five formats in both processing versions, samples actual TIFF readbacks, compares previous-export bytes and verifies source/preview/recipe preservation. Per-platform outcomes are recorded in [acceptance](acceptance.md). Synthetic and generated-file checks do not establish preferred strength for every photograph or a calibrated print result.
