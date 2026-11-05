# JPEG XL native working input

## Status

Accepted.

## Context

The published jSquash decoder already requests FLOAT from pinned libjxl, but converts those samples to sRGB bytes. Linear processing cannot recover precision after that conversion. FLOAT transport alone is insufficient: the actual DATA profile may describe encoded RGB, and may differ from the original profile for XYB. Existing recipes must retain their established byte output.

## Decision

Use one independently written public-API decoder core with legacy-byte and working-float adapters. Reuse libjxl's already linked skcms, interpreting DATA ICC and converting directly to a linear-sRGB FLOAT destination. Do not add another CMS runtime or route float samples through the normalized integer-input JavaScript adapter. Preserve source depth, exponent bits, structured color declarations and intensity metadata separately from output precision.

Independent LCMS comparison exposed misplaced XYZ PCS normalization in this pinned skcms mAB path: it scales before B curves, and omits the scale when no matrix exists. The working adapter normalizes the parsed matrix and applies the PCS factor after the transform into a linear destination; existing skcms tag accessors identify the selected LUT. XYZ mft2 also needs the post-transform PCS factor. XYZ mft1 has no standardized 8-bit PCSXYZ interpretation and uses explicit `jxl-profile-unsupported` compatibility. This correction does not change legacy output or duplicate the ICC parser. Identity and nonlinear B curves with and without a matrix require independent regression coverage.

The working adapter uses straight alpha because pinned libjxl already unpremultiplies. The legacy adapter retains the published decoder's alpha policy. Libjxl applies codestream orientation and coalesces layers; both adapters stop at the first full display frame. Original files and explicit processing-version selection remain unchanged.

Structured PQ/HLG uses explicit display compatibility because this revision's generated ICC curves are bounded approximations, not a complete HDR radiometric contract. Native out-of-range RGB combined with sampled curves or A2B also uses explicit compatibility. Both reuse the already decoded samples. Malformed input and failed color conversion remain visible errors.

## Consequences

Integer low bits, signed analytic color and floating highlights can reach the existing editor without an RGBA8 bridge. TIFF16 output exposes retained low bits; terminal display and other current outputs still quantize to 8 bits. In-range LUT interpretation follows pinned skcms, including A2B0-before-A2B1 priority; no general intent selection, proofing or arbitrary ICC conformance is claimed.

The old decoder artifact is replaced after actual legacy comparison. Validation tooling generates small original fixtures, while ordinary tests consume those fixtures offline. Compiler tools and validation WASM remain outside runtime assets. Source inspection, independent CMS measurements, browser workflows and native platform acceptance are distinct evidence.

## Alternatives considered

- Keep the byte decoder and linearize its output: loses low codes, wide gamut and highlights before editing.
- Request FLOAT and label it linear: misinterprets encoded source profiles; pinned preferred-profile behavior is conditional.
- Add another general CMS or extend the normalized JavaScript ICC adapter: duplicates an existing codec responsibility and changes unrelated input contracts.
- Treat every HDR/table transform as precision-preserving: ignores bounded transfer tables and missing radiometric semantics.
- Replace legacy alpha behavior at the same time: changes existing recipes; the explicit Linear version supplies the correct straight-alpha contract.

## References

- [Pinned source and legacy evidence](../../research/high-depth-jxl.md)
- [Color experiments and independent references](../../research/jxl-input-color.md)
- [Working-frame contract](../linear-working-frames.md)
- [Build recipes](../../scripts/codec-color/README.md)
