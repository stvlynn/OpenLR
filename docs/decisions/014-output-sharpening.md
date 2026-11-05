# Output-size sharpening

## Status

Accepted.

## Context

Photo Detail sharpening is stored in the recipe and affects previews. A separate output adjustment must operate at the exported dimensions without changing that recipe, original bytes or previews. Linear output must retain signed Float32 samples and TIFF16 precision. The Lightroom runtime record establishes an output control, not its algorithm or calibrated paper presets.

## Decision

Offer None, Low, Standard and High on the five rendered photo formats. Use one alpha-weighted linear-luminance Gaussian residual filter after final rendering/resizing and before watermark composition and target-space encoding. Limit added detail, not the source RGB range. Both Original and Linear adapters use this numerical owner; None leaves their existing byte-encoding paths unchanged. Use existing validation, dispatcher and completed-output settings persistence for UI and CLI.

## Consequences

Export sharpening stays independent of edit history and existing recipe behavior. The five-tap separable filter adds two Float64 scalar planes at output resolution; memory constraints remain visible rather than imposing a file-size limit. Gains and residual limits are selected from reproducible synthetic comparisons, not claimed as optimal for all photographs or print media. The original 8-bit canvas does not gain source precision from conversion to a linear frame.

## Alternatives considered

- Reusing `spatialEffectsFloat` with only recipe Sharpening would share code, but the measured per-channel response increased flat noise and changed an equal-luminance color edge more than the selected filter. It remains the existing edit algorithm; replacing it would silently alter saved recipes.
- Unbounded Gaussian residuals restored detail but produced much larger hard-edge halos. Limiting only added detail retained the measured advantage with bounded halos.
- Perceptual-lightness/libvips or multiscale diffusion pipelines offer other tradeoffs but introduce a new color-processing/dependency boundary or substantially more computation. Their source informed the evaluation; no upstream implementation was copied.
- Matte/Glossy labels without print density and material calibration would imply evidence not established by the current implementation or runtime observation.

## References

- [Output contract](../output-sharpening.md)
- [Primary sources and executed ablation](../../research/output-sharpening.md)
- [Completed-output settings](012-export-completion.md)
