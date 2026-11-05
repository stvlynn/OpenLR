# Explicit photo processing versions

## Status

Accepted.

## Context

Linear blending and retained RAW gamut change some rendered pixels. Reinterpreting historical recipes would silently change photographs, presets and named versions. A source cache keyed only by photo ID could also mix wide float and byte decodes after a processing change. Nested field-wise sync could combine an upgrade on one device with adjustments authored under the old algorithm on another.

## Decision

Absent `edit.processVersion` means original processing (1); explicit 1 and 2 are accepted and other values fail. The detail selector and `processing` command share the dispatcher. Linear processing (2) is an explicit still-photo choice, not an automatic rewrite of new or historical recipes. Original files are preserved. Switching is undoable, refreshes thumbnails and caches for the requested recipe, and clears comparison mode. Reset removes adjustments but retains the selected processing version. Neutral comparison and auto-exposure preserve it too.

Full copies and named versions carry the complete recipe. Selective copies leave other target keys intact. Presets carry their authored version; applying an old preset uses original processing. OpenLR XMP preserves and validates version, depth and blur settings. Model analysis derives its display input separately from the retained source frame.

Local sidecars and sync use their existing envelope-version mechanism: format 2 is required when a current or saved recipe contains process 2 (also presets in sync). Older code already rejects unknown envelopes. Do not introduce unrelated hashes or ignored capability flags. Sync promotion remains sticky; a processing transition is a whole-recipe conflict when both branches diverge from baseline, while unchanged/same-version edits retain established merge rules. Unknown local sidecars remain visible as errors and cannot be replaced by a silent legacy render/write.

## Consequences

Old appearance and explicit user choice coexist without a separate editor. This is an independent OpenLR processing version, not an Adobe Process Version or color-match claim. Version metadata alone does not mark a photo edited. Video, original export, DNG preservation and retained RGBE export keep their established contracts.

High-depth/wide raster decoding and large-image memory bounds still need further work; numeric float storage does not upgrade the existing display-decoded raster inputs. Current ordinary import defaults remain original until a broader default transition is evaluated.

## Alternatives considered

- Unconditional upgrade: changes historical pixels and saved snapshots.
- Only a display toggle: cannot determine source decode, export, or persisted semantics.
- Merge the version as an independent nested field: can apply old-domain parameters under a new domain without a conflict.
- Keep the old transport envelope and add a hint: older clients ignore unknown recipe fields and would misrender them.

## References

- [Float kernel decision](007-linear-working-frames.md)
- [Source and migration audit](../../research/precision-pipeline-audit.md)
- [Organization](../catalog-organization.md), [local folders](../local-folders.md), [sync](../library-sync.md)
