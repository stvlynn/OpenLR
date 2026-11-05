# Native integer input and bounded RGB profile interpretation

## Status

Accepted. Extends the non-RAW input boundary of [Linear working frames](007-linear-working-frames.md). Platform acceptance remains separately recorded in [acceptance](../acceptance.md).

## Context

The float renderer and TIFF16 output cannot restore low bits lost in an input bitmap/canvas. Pinned UTIF exposes decompressed integer bytes before `toRGBA8`; existing libavif bindings already support requested integer RGBA16. The [TIFF investigation](../../research/high-depth-tiff.md) found and reproduced tile stride/count defects and incomplete blocks silently filling missing samples with zero. The [AVIF experiment](../../research/high-depth-avif.md) found genuine 10/12-bit low codes remain distinct through the shipped decoder, with at most one UInt16 output-code difference from ideal rescaling. No new codec or binary rebuild is necessary.

Native integer samples still need an explicit color interpretation. Structural ICC validation accepts containers that a matrix-only interpreter cannot honor, including profiles with LUT precedence. Repackaging samples as a tagged PNG and reading an RGBA8 canvas preserves existing display behavior but discards source precision and clips colors to the display representation. Introducing a general CMS also adds a runtime, build, allocation, worker and distribution boundary.

## Decision

Keep existing codec and color owners. Extend the common codec worker/kernel with a working-frame decode operation. TIFF reads normalized integer samples from the same corrected UTIF decompressor used by the display adapter; AVIF requests existing integer RGBA16 and records actual source depth separately. There is no second TIFF parser, decoder, export writer or image-processing pipeline. Original source files and existing Original-processing behavior remain preserved; Linear remains explicit version-2 opt-in.

Use a shared bounded RGB ICC matrix/TRC interpreter with the existing color-space matrix composition. It accepts normalized unsigned source samples and evaluates serialized forward curves and D50 colorants directly into signed, unbounded linear sRGB. Supported curves include identity, gamma, sampled interpolation and v4 parametric functions 0–4. Device-to-PCS LUT declarations, unsupported profile classes/interpretation and other valid unsupported containers return a reason; malformed profiles fail. The owning [input color contract](../export-color.md#input-color-and-re-import) defines the subset, and [linear frames](../linear-working-frames.md) defines codec/CICP/layout behavior.

Keep the existing host display/CMS route as explicit compatibility for supported but uninterpreted profile/CICP cases. Compatibility frames say `rgba8-display` with a reason; native frames record actual source/output depth and transform. Info and full/summary agent state expose the current decode provenance. PNG/JPEG XL source depth, general LUT/CMYK transforms and PQ/HLG working conversion remain explicit limitations. Unsupported capability is distinct from malformed input and does not authorize silently treating a tagged source as sRGB.

Apply targeted, count-checked UTIF corrections in the existing vendor build. Retain its MIT notices and mark local changes. Validate block extents/decoded lengths, handle padded final strips and bound LZW code reads so malformed data cannot become fabricated black pixels or an unbounded decode loop. Worker startup fallback executes this same code; a processed corrupt input does not trigger another decoder.

## Consequences

Supported TIFF/AVIF low bits and wide colors reach ordinary float edits and genuine TIFF16 output without a byte bridge. Alpha remains separate from color conversion, and source ownership/revision guards remain unchanged. Compatibility stays visible and host-dependent; it cannot establish native high-depth or HDR support. Original display rendering remains available, and structural validation is not general CMS conformance.

No arbitrary photo size ceiling or runtime dependency is added. Full-frame integer/Float32 allocations remain constrained by memory and codec limits; this decision does not establish large-image throughput or other-platform acceptance.

## Alternatives considered

| Alternative | Evidence and reason |
| --- | --- |
| Retain the existing RGBA8 display bridge for every raster source | Measured low TIFF/AVIF codes collapse at the byte boundary; a Float32 destination or TIFF16 container cannot reconstruct them. Keep this route only as explicit compatibility |
| Compile Little CMS to WASM | Mature LUT/intent coverage is useful for a future general CMS. Native LCMS 2.17/2.19 comparisons already validate this limited interpreter: maximum linear-sRGB difference was 3.1461×10⁻⁷ for analytic curves and 2.2009×10⁻⁵ for sampled tables. Those measurements do not validate a WASM integration; a new runtime is unnecessary for the selected subset |
| Native OS CMS with 16-bit transport | Requires separate platform adapters and proof of actual precision/unbounded output. An integer sRGB destination can still clip wide colors; no cross-platform precision claim was established |
| Browser float/linear canvas conversion | Available APIs and host support vary and do not provide the selected arbitrary-ICC-byte interpreter contract. The existing byte bridge remains a measured precision boundary |
| Separate TIFF parser or replacement codec | The existing decoder exposes the needed samples; 1,056 generated strip/tile cases decoded exactly after targeted shared fixes. A second implementation would duplicate format rules and require a new provenance/interoperability review |

## References

- [TIFF source, original failures and reproducible repair](../../research/high-depth-tiff.md)
- [AVIF depth/rescaling, ICC/CICP and alpha evidence](../../research/high-depth-avif.md)
- [ICC specifications, independent CMS measurements and boundaries](../../research/float-input-color.md)
- [Explicit processing-version decision](008-processing-version.md)
- [Template provenance](../template-sources.md)
