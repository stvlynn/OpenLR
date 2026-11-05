# Output sharpening research and ablation — 2026-11-05

## Evidence boundaries

`research/lightroom.md` records a real Windows Lightroom 9.4 export-preview control for output sharpening and strength. The observer cancelled, wrote no Adobe output, and did not record Screen/Matte/Glossy menu values. This is UI evidence, not an Adobe sharpening algorithm or pixel oracle. No Adobe code, image or string is imported.

OpenLR currently applies recipe `Sharpening` inside `spatialEffects` / `spatialEffectsFloat` after geometry/resizing, along with other image adjustments. It is photo edit state and affects previews. The export command already owns final-size rendering, then watermark, then target-space encoding. A distinct optional output step belongs after final rendering/resizing and before watermark; it must not change photo edits, previews or original bytes. `none` must leave the existing encoding route intact.

## Primary sources actually consulted

- Context7 `/lovell/sharp`, queries for sharpen sigma, Lab luminance, alpha and pipeline ordering. Its result links [Sharp's own operation documentation](https://github.com/lovell/sharp/blob/v0.35.5/docs/src/content/docs/api-operation.md). Sharp documents a fast mild filter and a slower Gaussian-scale Lab-lightness sharpen with controls for low-detail regions, edges and maximum bright/dark changes.
- [Sharp v0.35.5 pipeline.cc](https://github.com/lovell/sharp/blob/v0.35.5/src/pipeline.cc#L391-L411), inspected raw source: resize occurs before sharpening; alpha is premultiplied for spatial operations and reversed afterward. Sharpening precedes compositing (lines 665–677). This supports final-size filtering and avoiding watermark sharpening, but does not establish an OpenLR pixel algorithm.
- [Sharp v0.35.5 operations.cc](https://github.com/lovell/sharp/blob/v0.35.5/src/operations.cc#L215-L240) implements separate fast convolution and libvips luminance-sharpen routes. Apache-2.0 source was inspected, not copied.
- [libvips v8.18.0 sharpen.c](https://github.com/libvips/libvips/blob/v8.18.0/libvips/convolution/sharpen.c#L373-L427) describes Gaussian residual sharpening of Lab L, separate edge/flat response and bounded detail addition. Its print guidance changes radius with raster pixels/mm; paper labels alone do not identify calibrated parameters. Source is LGPL-2.0-or-later; no code was imported.
- [darktable's own diffuse-or-sharpen manual](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/diffuse/) describes a linear RGB approach, artifact controls and a costly multiscale diffusion solver. It supports preserving the existing linear working contract as a valid design option, not copying that solver or claiming it is equivalent to perceptual L sharpening.

RawPedia Resize/Toolchain URLs returned 404 in this session; no claims rely on them. Current web docs above were read, and versioned upstream source links retain the inspected implementation references.

## Product scope

Expose one **Output sharpening** choice: None / Low / Standard / High. None is default. Support the existing five rendered photo formats and existing still-frame export path; reject a non-none setting for original/recipe/DNG/video-container outputs rather than silently ignoring it. Share validation, successful-output settings persistence, CLI and GUI via the existing owners. Do not add guessed Matte/Glossy presets: there is no printer/paper/physical-density calibration or observed menu evidence establishing those labels. This is output-size acutance, not print calibration or Adobe parity.

Preserve the signed, unbounded Float32 linear-sRGB contract. Never convert a Linear frame to 8-bit for filtering. The Original canvas adapter can convert its already-8-bit samples into the same linear kernel only when enabled. Normalize blur contributions by alpha; do not sharpen alpha or allow hidden transparent RGB to influence visible neighbors. Apply bounded detail before target-space conversion/quantization. Watermark composition remains afterward.

## Actual generated ablation

Ran `node research/output-sharpening-experiment.mjs` with Node 24 on Windows. Outputs are `.workspace/output-sharpen-ablation.json`. Images are deterministic 128×64 generated arrays, not photographs:

- Known clean sinusoidal/step detail, blurred with Gaussian sigma .8, then restored candidates; RGB MSE to the clean source measures reconstruction on this fixture.
- Soft and hard neutral edges measure center contrast and halos.
- Seeded small flat-field noise measures standard-deviation amplification.
- Isoluminant colored edge measures unwanted luminance/channel-difference changes.
- Transparent hidden extreme RGB beside constant visible RGB checks alpha and color contamination.
- Signed and above-one float samples check finite, unclipped behavior.

Compared existing `spatialEffectsFloat` at Sharpening 10/20/35, alpha-weighted Gaussian luminance USM gains .3/.6/1, an absolute .025 cap, and caps proportional to gain with .025 and .015 scales. Gaussian sigma .65 has five taps. The luminance candidate adds one residual equally to RGB, preserving channel differences before floating rounding; this is not a claim of invariance in every perceptual color space.

| Candidate | Detail MSE | Soft-edge contrast | Noise std ratio | Hard-edge halo | Isoluminant max Y / R−G change |
| --- | ---: | ---: | ---: | ---: | ---: |
| None | .00016935 | .24934 | 1.000 | 0 | 0 / 0 |
| Existing 10 | .00012728 | .25087 | 1.297 | .00418 | .00178 / .00794 |
| Existing 20 | .00009320 | .25241 | 1.605 | .00836 | .00355 / .01588 |
| Existing 35 | .00005704 | .25471 | 2.077 | .01463 | .00622 / .02779 |
| Gaussian .6, uncapped | .00008674 | .28136 | 1.378 | .05798 | 0 / 0 |
| Selected Low | .00012458 | .25834 | 1.187 | .00450 | 0 / 0 |
| Selected Standard | .00008748 | .26734 | 1.378 | .00900 | 0 / 0 |
| Selected High | .00004997 | .27934 | 1.635 | .01500 | 0 / 0 |

Chosen constants: sigma .65 output pixels, gains .3/.6/1, maximum added residual ±(.015×gain). The .015 scaled cap substantially reduces uncapped hard-edge halos while retaining the measured detail/noise advantage over reusing the existing RGB edit filter. Both filters preserve alpha and the visible constant-color edge; the existing filter changes fully transparent hidden RGB, while the candidate leaves it untouched. Every candidate retained finite negative and above-one samples. These small synthetic fixtures do not establish best parameters for every photo, natural-image preference, print behavior, or a real resize pipeline; E2E must still cover actual resized encoded exports.

## Implementation and verification

`web/output-sharpening.js` independently implements the selected math, using the existing frame assertion and shared output-level/message contract. The frame is caller-owned and modified in place. None returns the same frame without allocations. Two Float64 horizontal planes hold alpha-weighted luminance and coverage before any pixel mutation; the vertical pass reads those immutable planes. Only detail is bounded; original signed/HDR RGB is not clamped. A machine-epsilon check suppresses arithmetic roundoff in constant colors, not a content threshold or size gate.

`node --test tests/output-sharpening.test.js`: **4/4 pass**, zero skipped. Checks include exact None identity, invalid input, uniform and narrow images, alpha/hidden RGB, signed/HDR retention, an independent direct 2D convolution oracle against the separable implementation, monotonic strengths and bounded halos. The production implementation was also added to the scratch ablation and matches the selected candidate's recorded metrics.

No runtime dependency, upstream source, proprietary algorithm or asset was added. The new output kernel is a distinct measured responsibility; the existing edit-sharpening behavior remains unchanged. The [output contract](../docs/output-sharpening.md) owns GUI/CLI behavior and the [acceptance record](../docs/acceptance.md) records actual browser and native platform results.
