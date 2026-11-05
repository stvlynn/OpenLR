# 006: Explicit RGB output transforms and matching profiles

## Status

Accepted, 2026-11-05.

## Context

The renderer currently produces 8-bit sRGB. Lightroom runtime inspection establishes five export choices but does not reveal its ICC data or algorithms. Adding labels without transforming samples would produce wrong colors. The existing TIFF export helper has fixed storage offsets, while AVIF/JXL bindings do not expose output profiles.

## Decision

Use one independent named RGB matrix/TRC domain module for the five defined spaces and their generated ICC profiles. Keep the current sRGB edit contract explicit. The shared export capability owner exposes all five spaces for JPEG/PNG/TIFF and only sRGB for existing AVIF/JXL bindings. The dispatcher rejects unsupported combinations. Convert samples before embedding the matching profile; keep generated files separate from originals and edit recipes.

Reuse the codec worker for conversion and encoding. PNG uses explicit samples plus iCCP; JPEG retains host compression and replaces color declarations; TIFF uses one dynamic serializer instead of the fixed-offset helper. Re-import RGB ICC TIFF through a tagged PNG bridge to the host CMS, preserving existing orientation and alpha handling.

## Alternatives and evidence

The [independent Little CMS experiment](../../research/color-transform-experiment.md) compares matrix/TRC conversion plus a profile with a profile-only negative control over 5,265 colors. Real conversion maintains appearance much more closely; label substitution is rejected. A general LCMS/skcms runtime can handle broader profile classes, but would add a runtime build and interface before this fixed-space output contract requires it. It remains a candidate for general input/print management. Browser P3 canvas alone does not cover all five spaces or guarantee identical host behavior. Pretending that the packaged AVIF/JXL bindings expose their underlying codecs' complete capabilities is rejected.

## Consequences

The app adds actual color-preserving target encodings without pretending to recover discarded gamut or precision. Conversion has one owner across workers, fallback, GUI and CLI. ICC integer coefficient rounding and 8-bit quantization remain measurable limits. TIFF's PNG bridge trades extra encoding/memory for the host CMS and must be verified on every native platform. General wide-gamut editing, arbitrary ICC transforms, high-bit-depth export, AVIF/JXL profile bindings and HDR display are still required future work, not removed from the overall objective.

See [product behavior and verification](../export-color.md) and [prior investigation](../../research/color-management.md).

## Extension: AVIF and JPEG XL bindings

The original capability restriction is superseded by rebuilt bindings in `scripts/codec-color/`. All five rendered formats now share the same named-space conversion contract. AVIF exposes native RGB plus ICC/CICP and reuses the existing host-CMS bridge; JPEG XL sets `uses_original_profile` for target samples and retains its existing skcms decoder. Fixed-source builds replace the old encoder artifacts rather than adding target-only parallel encoders. Actual VarDCT/modular ablation supports VarDCT for lossy output; sRGB lossy retains XYB. [AVIF](../../research/avif-color-binding.md) and [JPEG XL](../../research/jxl-color-binding.md) records distinguish independent sample/profile verification from browser and native workflow acceptance.
