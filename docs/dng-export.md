# DNG export

Choose **DNG · original or 16-bit linear RAW** in Export, or use:

```powershell
node cli/openlr.mjs export --format image/x-adobe-dng --output camera.dng
```

An existing DNG is returned byte for byte, preserving its sensor image, compression, metadata, original color calibration, and orientation. OpenLR does not rewrite that file to bake in display edits. Use **Original + settings** to archive the untouched source with the current XMP sidecar. A TIFF header plus the DNG version tag is checked before taking the preservation path; filename extension alone is not treated as proof of DNG content.

Other camera RAW files supported by the actual LibRaw decoder are exported as **processed LinearRaw DNG**. They use the shared full-resolution 16-bit linear decoder, with camera white balance and no automatic brightening. Source orientation has already been applied by that decoder, so the new file stores the oriented dimensions and Orientation 1. These files preserve the available decoded 16-bit RGB values, not the original CFA mosaic or vendor-private metadata; the original camera file remains untouched in the catalog or local folder.

The writer emits uncompressed, three-channel unsigned 16-bit strips with LinearRaw photometric interpretation, zero black level, 65535 white level, neutral already-balanced channels, and the D65 XYZ-to-linear-sRGB color matrix appropriate to its actual pixel space. Capture exposure metadata is retained where available. Current settings are embedded as XMP using the project's shared exporter, rather than applied to the RAW samples. Resizing and watermarks are unavailable for DNG; use a rendered export for those operations.

PNG, JPEG and other rendered inputs are rejected as camera RAW sources. The implementation does not expand 8-bit preview values into a nominal 16-bit container. HDR scene radiance remains available separately through `export-hdr`; the normalized 16-bit camera-RAW writer does not silently clip scene values above one.

The container is a project implementation of the publicly documented TIFF/DNG layout. It uses 256-row strips and automatically selects the specified 64-bit BigTIFF layout when calculated offsets need it. Ordinary files use the compatible 32-bit layout. No application-level file-size ceiling is introduced; browser allocation/Blob limits and available memory still apply. Multi-gigabyte allocation and cross-application BigTIFF interoperability have not been validated.

The format evidence and library choices are recorded in [DNG research](../research/dng-export.md). The Adobe DNG SDK is not linked or redistributed. `tests/dng.test.js` uses actual LibRaw readback plus an independent TIFF metadata reader. It verifies exact original-DNG preservation, non-8-bit sensor precision, tags and matrices, orientation, embedded settings, and rendered-input rejection. A genuine CC0 Canon G1 CRW fixture verifies the export dispatcher and conversion branch: 2088×1550 pixels, mean linear sample error about `5.14e-6`, maximum error about one 16-bit level. This does not establish support for every camera model or prove Adobe `dng_validate` conformance.
