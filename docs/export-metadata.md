# Photo metadata in rendered exports

Export offers **None**, **Copyright only**, and **Copyright & photo info** for JPEG, PNG, TIFF, AVIF and JPEG XL. None remains the default. GUI, CLI and **Export again** share the same policy and completed-export preferences.

```sh
node cli/openlr.mjs export --format image/png --metadata copyright --output photo.png
node cli/openlr.mjs export --format image/tiff --metadata supported --colorSpace display-p3 --output photo.tif
node cli/openlr.mjs export-previous --output next.tif
```

| Policy | Source fields |
| --- | --- |
| `none` | No source photo metadata |
| `copyright` | Copyright / XMP rights only; not the author's identity |
| `supported` | Copyright, Artist/creator, Make, Model, LensModel, DateTimeOriginal, ExposureTime, FNumber, ISO and FocalLength |

This is an explicit field set, not an arbitrary “all metadata” copy. GPS, keywords, MakerNote, thumbnails, original editing recipes, unknown/private tags and Content Credentials are not copied. Missing fields remain absent; no copyright is inferred from an author, account or filename. Output layout fields, encoding declarations and the selected ICC profile still describe the actual new image under every policy.

Original, Original + settings, XMP sidecars, DNG and video keep their existing preservation/export contracts. They reject non-`none` photo metadata policies. A video frame can still be exported as a rendered image; unavailable photo fields are not invented.

## Encoding and input semantics

The policy owner selects fields once and builds standard XMP plus compatible EXIF mirrors. XMP carries Unicode rights and creator text, including non-Latin characters and emoji. Legacy EXIF ASCII text mirrors are emitted only when representable; Unicode bytes are not mislabeled ASCII. Numeric fields use TIFF types and rational values. Source capture time retains known fractional seconds and offset; an unknown timezone is not converted into a made-up UTC timestamp.

Multiple XMP creators retain their order and names as separate entries. A single creator remains a string in catalog metadata; multiple creators are an ordered array. An ASCII-only EXIF Artist mirror joins names with `; `, while XMP remains the authoritative list. Copyright only includes no creator entries.

XMP rights and creator take precedence over their EXIF counterparts. Camera fields use known EXIF values with supported XMP fallbacks. Non-default export re-reads the original's metadata, so an older catalog's empty display cache does not silently discard newly supported fields. Reading/encoding failures are visible. Ordinary import retains its existing tolerant metadata-display behavior.

The existing XMP reader normalizes surrounding text whitespace; this is semantic field preservation, not byte-for-byte preservation of the original XML packet. Unicode text, XML entities and combining characters in the generated tests retain their content.

Every rendered output rebuilds dimensions and Orientation 1 from the final pixels. Source rotation, old pixel offsets, source ICC and stale color-space declarations cannot override the rendered image. JPEG metadata is placed in APP1 markers while preserving compressed image data and ICC; PNG uses eXIf and UTF-8 iTXt; TIFF uses the shared IFD layout with an Exif subdirectory and XMP tag 700. AVIF uses libavif's metadata item APIs. JPEG XL uses libjxl's container boxes, with the required Exif offset prefix and lowercase `xml ` type.

AVIF/JPEG XL input reads metadata extents without decoding or copying their image payloads. Compressed JPEG XL metadata boxes and unsupported AVIF item layouts report an error during a requested metadata export rather than silently losing fields. This does not claim interpretation of every vendor metadata schema. JPEG APP1's actual format limit can reject oversized metadata; no photo-file size ceiling is introduced. Existing TIFF/BigTIFF and memory limits remain documented in [image codecs](image-codecs.md).

## Verification

`tests/fixtures/export-metadata.png` is an original generated image with fictitious EXIF/XMP, Unicode rights, a capture offset, source orientation and deliberate GPS/private editing fields. Its generation record is [here](../research/export-metadata.md). No personal or Adobe photo is used.

```sh
node --test tests/export-metadata.test.js tests/metadata-containers.test.js tests/export-metadata-workflow.test.js
node scripts/native-smoke.mjs /path/to/OpenLR
```

The browser workflow checks all five formats and all three policies in both processing versions, actual decoded pixels, normalized dimensions, original bytes, GUI Save, restart and previous-settings reuse. Container tests check TIFF 8/16-bit samples, offsets, PNG CRC/chunk payloads, JPEG markers and real segment limits. Codec binding experiments exercise all scalar/threaded/SIMD variants and compare output with metadata disabled against the prior encoders.

Independent ExifTool validation is optional tooling, not an application dependency. Tests use the official source revision `980409314fddbd83d9092b5c160fafab7f67fd52` (13.60) under `.tools/exiftool-980409314fddbd83d9092b5c160fafab7f67fd52/`, invoked with Perl (WSL Perl on Windows). Set `OPENLR_TEST_METADATA=1` to require it; absence otherwise produces an explicit skip. ExifTool reads JPEG XL metadata boxes but does not expose its codestream ICC in these samples; libjxl checks the actual original ICC separately. Do not confuse that oracle limit with missing color characterization.
