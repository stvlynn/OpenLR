# Linear Float32 working frames

## Status

Accepted for the processing kernel. Application recipe migration and default activation remain pending.

## Context

The existing byte renderer clips between local and global adjustments. In the measured full-mask +4 EV / global −4 EV experiment, a 256-level ramp collapses to 72 levels. Encoding that result into a 16-bit container cannot recover the lost samples. The [precision experiment](../../research/pipeline-precision.md) found Float32 storage preserved all 65,536 tested values with maximum error below 1e-6; Float16 and integer intermediates did not.

## Decision

Use owned `{ width, height, data: Float32Array, colorSpace: 'srgb-linear' }` frames with straight alpha. RGB is finite, signed, and unbounded; alpha is in [0,1]. Extended linear sRGB can represent colors outside the display gamut. Convert and quantize at an explicit output boundary, never between ordinary edit stages.

Keep the existing stage implementations as owners of their rules. A common source-stage scheduler runs fill, red-eye, local repair/depth/masks and optics. Both representations retain the subsequent crop/turn/reflection, global tone, curve, mixer and spatial order. The legacy adapter retains byte quantization and its exact existing output. The float adapter shares formulas and coordinate maps, with explicitly different interpolation and extension policies documented in [the kernel contract](../linear-working-frames.md).

RAW working decode explicitly requests LibRaw output color 4 with identity transfer and 16-bit samples, then inverts the exact pinned output matrix into extended linear sRGB. This purpose is separate from the existing linear sRGB DNG/HDR API. LibRaw's earlier clipping remains a source limitation. Non-RAW fallback is explicitly identified as an 8-bit display decode; Float32 storage does not invent source precision.

Extend the existing TIFF writer to accept actual Uint16 samples. The float output adapter converts into the selected RGB space before terminal clipping and 16-bit quantization, then writes the matching ICC. There is no second TIFF writer or generic ICC interpreter.

## Consequences

Kernel tests can now traverse genuine wide RAW samples, all ordinary edit stages and a real 16-bit output. This does not activate a new application process version. Existing catalogs and GUI/CLI exports remain on their documented legacy policy until versioning, source-cache ownership, neutral comparisons, reset, sidecars, presets, sync and XMP are integrated and accepted together.

A 24 MP RGBAFloat32 buffer takes about 384 MB. The renderer owns a copy and some stages allocate further buffers. Tiling, large-image memory/latency measurement and native acceptance of the new path remain work; no arbitrary file-size gate is introduced.

## Alternatives considered

- More bits only in the export container: rejected by the clipping experiment.
- Float16 intermediates: rejected for this CPU contract by measured precision loss; future GPU storage requires separate evaluation.
- Clamped linear sRGB RAW decoding: retains low bits but loses measured wide colors.
- An independent reduced float renderer: would omit edits and duplicate rules. Existing stage owners instead support both pixel policies.
- Switching all saved recipes immediately: changes appearances and creates unresolved cache and cross-device interpretation bugs.

## References

- [RAW precision and pinned LibRaw source](../../research/high-precision-raw.md)
- [Full pipeline and migration audit](../../research/precision-pipeline-audit.md)
- [Original template provenance](../template-sources.md)
