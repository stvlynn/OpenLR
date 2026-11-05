# Source-coordinate dehaze with shared linear reconstruction

## Status

Accepted, 2026-11-05; measured acceptance remains separately recorded.

## Context

Clarity does not implement atmospheric veil removal. Installed Lightroom evidence establishes a Dehaze control but not its algorithm. Independent reconstruction must preserve original bytes, old neutral recipes, source-coordinate consistency and signed/HDR samples. Estimating haze after creative grading or from arbitrary preview dimensions changes the inference.

## Decision

Use a scalar Effects control and one linear domain operation: patch dark-channel estimation, deterministic atmospheric-light selection and alpha-weighted guided transmission refinement. Apply strength through transmission and preserve RGB without clipping; negative strength synthesizes a uniform airlight veil. Estimate after source corrections/optics, before geometry and creative global operations. Bypass completely at zero.

Reuse the latest corrected source and analysis for each immutable source object and source-correction recipe. Amount/crop/output size are not analysis keys. Mutable canvas/video inputs are not cached. Existing controls, command validation, history, copy categories and persistence own the interaction, without a second pathway. Fused streaming weighted moments reduce repeated passes and retain exact source-resolution statistics. A shared pixel mapper reconstructs before interpolation/encoding without a full floating output copy. Full-resolution analysis remains exact; its resource cost is measured rather than hidden behind an arbitrary size ceiling.

## Consequences

Preview and export share the same spatial estimate. Enabling dehaze makes legacy pre-geometric corrections run at full source resolution; neutral recipes retain their old path. Analysis is not depth recovery or guaranteed haze detection: bright surfaces can be severely overcorrected, as the retained negative experiment shows. Production analysis uses the existing worker queue with consumer-aware cancellation and source/revision publication guards. Original reconstruction/byte conversion uses that same queue with owned copies allocated only at admission, preserving published cache snapshots and bounding queued-copy accumulation. Linear reconstruction/geometry and subsequent floating operations use the same queue through the shared frame-render kernel; the synchronous renderer and startup fallback reuse that kernel. Source preparation, display encoding, canvas upload and Original's later color operations remain synchronous and can delay interaction on large images. Reusing analysis reduces repeated strength-adjustment work but does not remove source-sized copies and reconstruction cost.

## Alternatives considered

Per-pixel estimation distorted the generated clear scene. Patch minima improved reconstruction; guided refinement gave lower whole-scene and boundary error than plain box smoothing in the declared fixture. Histogram/preview-dependent estimation would change with rendering dimensions. The fixed RGB analysis pyramid experiment lost sparse dark anchors and overcorrected; it is rejected for the current implementation. Asynchronous analysis and Original conversion reuse exact kernels and existing transport. The transport ablation favored explicit copy/transfer over structured-cloned messages for main-thread responsiveness; this adds measured source-sized storage, not a lower-resolution shortcut. A new codec, copied third-party implementation or separate persistence engine is unnecessary.

## References

- [Primary sources, equations and ablation](../../research/dehaze.md)
- [Product and CLI contract](../dehaze.md)
- [Linear pipeline](../linear-working-frames.md)
