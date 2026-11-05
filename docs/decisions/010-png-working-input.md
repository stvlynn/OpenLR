# PNG source samples and color characterization

## Status

Accepted as an extension of [native integer input](009-high-depth-input.md). Verification results and limits belong to the linked research and [acceptance record](../acceptance.md).

## Context

The browser PNG decoder supplies a display surface, not an original-sample contract. A generated RGB16 image with 512 consecutive source values retained only three red byte levels after native decoding and canvas readback. Moving that display result into Float32 cannot recover the lost distinctions. PNG also carries its own color-chunk priority, full-depth transparency keys, packed samples, byte filters and interlaced passes; applying the AVIF metadata rule would misinterpret PNG color.

## Decision

Decode PNG working input into owned normalized straight RGBA samples before color conversion. Implement the PNG-specific reconstruction once, using existing pako inflation and a chunk/CRC primitive shared with the current PNG writer. Support the defined static sample layouts, five filters and Adam7 passes. Preserve source bytes, alpha and hidden straight RGB, and compare tRNS keys at the original integer depth. Keep the existing native Original-processing adapter; no existing photo is silently upgraded.

The PNG color owner selects cICP, embedded ICC, sRGB, or gamma/chromaticities in specification order. It reuses the existing RGB/gray ICC curve interpretation and colorant/Bradford matrix owner. PNG gAMA is an encoding gamma, so the forward decoding exponent is its reciprocal; it is not automatically the sRGB curve. Missing information is an explicit recorded assumption. Valid unsupported color characterization uses the host display adapter with compatibility provenance, while malformed interpreted data fails visibly. Alpha does not pass through a tone curve.

Use the shared codec worker and startup fallback. Original and Linear still photographs must depict the same first animation frame for APNG; this does not add animation editing or playback. Apply EXIF orientation through the existing exifr parser and a shared pixel-orientation mapping, after numeric color conversion. Native Chrome observations establish that its bitmap adapter applies all eight orientations, so ignoring orientation in Linear would change existing geometry.

CRC and dimensions/stream-length checks enforce the image format, not a file-size policy or an arbitrary cryptographic gate. Use existing buffer/resource limits rather than an arbitrary photo-size ceiling. PNG-specified recovery remains observable in provenance; an unrecoverable palette entry additionally has a concise user-visible diagnostic.

## Alternatives

| Route | Evidence and tradeoff |
| --- | --- |
| Browser bitmap followed by Float32 | Actual 512-to-3-level ablation loses source precision; remains only the Original/display compatibility route |
| Add another PNG package or build libpng WASM | Existing dependencies contain no full PNG pixel decoder, but already provide zlib and an independently implemented writer. A new package/binary adds provenance, deployment and lifetime concerns without removing the need for explicit color/alpha integration |
| New standalone color engine for PNG | Duplicates existing matrix, adaptation and ICC-curve responsibilities; instead the shared color owner is extended for actual gamma/chromaticity and gray-profile input |
| Read only noninterlaced RGB16 | Leaves valid grayscale, alpha, palette and Adam7 files on a different precision path; one numeric reconstruction handles the defined layouts |
| Decode APNG default IDAT regardless of frame controls | A generated file with red default image and green first animation frame displays green in the existing native path. The first-frame selection must follow animation control data to preserve the selected photograph |

## Evidence

- [PNG sample reconstruction and browser ablation](../../research/high-depth-png.md)
- [PNG color priority and independent color checks](../../research/png-input-color.md)
- [PNG third edition](https://www.w3.org/TR/2025/REC-png-3-20250624/)
- [Linear working-frame contracts](../linear-working-frames.md)
