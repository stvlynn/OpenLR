# Shared linear tonal color grading

## Status

Accepted, 2026-11-05.

## Context

Existing HSL and point-color controls select color ranges, not tonal regions. Installed Lightroom runtime observations establish the four-wheel interaction family but do not disclose rendering mathematics. New editing must preserve old recipe output, signed/HDR samples and existing persistence boundaries.

## Decision

Use one `colorGrading` domain owner with strict canonical validation and a compiled linear sRGB operation. Apply zero-luminance hue tint using immutable input amplitude and smooth normalized shadow/midtone/highlight masks; apply a separately weighted exposure-like luminance gain. Global tint/gain is independent. Both byte and float renderers invoke this operation after the color mixer. Neutral recipes compile away exactly.

Provide three-wheel and individual/global views with numeric and keyboard alternatives. A transient gesture captures photo/recipe ownership, previews without persistence and dispatches one guarded replacement on completion. Curve and grading previews reuse the same app-level revision-aware preview adapter. Copy, versions, presets, XMP, sidecars and sync retain their existing owners.

## Consequences

The new owner does not change old processing order or rewrite originals. Dormant hue and balance/blending are preserved without falsely marking a neutral photo Edited. Exact black is not lifted; signed/HDR colors remain unclipped until output conversion. Equal saturation values are not proven perceptually uniform, and bounded displays can clip the result. This implementation does not reproduce Adobe or darktable algorithms.

## Alternatives considered

The independent numerical ablation rejects uncentered tint addition because it changes luminance, and hard tonal bands because they introduce abrupt transitions. A histogram-normalized partition would make identical pixels depend on neighbors and crop. A separate byte algorithm or new grading persistence pathway would duplicate actual rules. Importing a third-party perceptual color engine adds dependencies without demonstrated need for this declared contract.

## References

- [Research and reproducible ablation](../../research/color-grading.md)
- [Behavior and command contract](../color-grading.md)
- [Linear working frames](../linear-working-frames.md)
