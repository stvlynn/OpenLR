# Use a local LibRaw WASM codec adapter

## Status

Accepted for the current browser/MyGo implementation; validated in Chrome, with other WebViews still requiring platform tests.

## Context

Camera RAW is not decoded by the browser image API. Import, catalog reload and export require the same decoder; original files must survive unchanged. Native-only bindings would fragment the desktop/browser workflow, and remote conversion would require sending photographs away.

## Decision

Use pinned `@colorhythm/libraw-wasm` 1.1.1 through `decodePhoto(file) -> Promise<ImageBitmap>`. Keep WASM and its corresponding source/licenses as local assets. A disposable Worker owns each RAW decode and its WASM heap. Serialize RAW work and cap elapsed time; rely on actual runtime allocation limits rather than an artificial size ceiling. Decode the oriented full-resolution camera-WB sRGB base, disable auto brightness, and keep application editing in the existing renderer.

## Consequences

Decoding works offline in a compatible browser and can be embedded by MyGo without platform codec builds. The same adapter can serve import and export. Original RAW files remain intact, but editing/export is currently 8-bit after decoding. Workers incur startup cost and limits may reject large files; optional RAW compression is not guaranteed. Corresponding source, license notices, and library replaceability must remain in distributions. See [RAW decoding](../raw-decoding.md).

## Alternatives considered

- Browser image decoding alone: keeps the normal raster path but cannot support RAW.
- `ybouane/libraw-wasm` 1.6.0: useful Worker API; the inspected alternative had less complete wrapper license packaging and a larger compiled dependency surface.
- Native LibRaw/rawpy: adds OS-specific delivery and a second browser codec path.
- New custom RAW parser or shader demosaic: unnecessary duplicate complex format/algorithm work for this stage.
- Remote conversion: conflicts with the requested local original-preserving workflow.

## References

[LibRaw](https://github.com/LibRaw/LibRaw), [selected wrapper](https://github.com/colorhythm/libraw-wasm), [version and source archive ledger](../raw-decoding.md).
