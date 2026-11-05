# Rebuild selected metadata for rendered output

## Status

Accepted.

## Context

Rendered photo exports previously discarded source metadata. The installed Lightroom runtime and official desktop documentation show metadata choices, but they do not establish a byte-level implementation or require copying unknown vendor data. OpenLR needs one explicit policy shared by GUI, CLI, processing versions and reusable export settings.

## Decision

Keep None as the existing default; offer rights-only and an enumerated photo-info policy across all five rendered formats. Rebuild selected EXIF/XMP fields instead of copying source blocks. Use Unicode XMP with representable EXIF mirrors, preserve known date offsets, and derive geometry/color declarations from output pixels. Reuse the existing TIFF layout for both metadata TIFF payloads and rendered TIFF files. Use libavif/libjxl's existing container APIs instead of a second BMFF/JXL writer.

## Consequences

Policy changes do not change rendering or original bytes. Explicit metadata export reads the original and reports interpretation/write failures. Unknown/private fields stay excluded, and supported fields are named honestly. Metadata preferences reuse the existing output-completion contract. No new runtime package or startup service is required.

## Alternatives considered

- Copy original EXIF/XMP wholesale: rejected because it carries stale dimensions/orientation, private data, old edits and potentially invalid provenance signatures into changed pixels.
- XMP only: preserves Unicode but omits conventional EXIF camera-field interoperability; retain both standards with one selected-field model.
- Separate TIFF or BMFF writers for metadata: duplicates layout/offset responsibilities already owned by a writer or the codec library.
- Add a general native metadata service: adds platform/runtime packaging for a bounded field set. ExifTool is used independently for validation, not as a production dependency.

## References

- [Behavior and field contract](../export-metadata.md)
- [Source evidence and experiments](../../research/export-metadata.md)
- [Completed-export settings](012-export-completion.md)
