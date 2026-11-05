# PNG native sample precision

Investigated and implemented on 2026-11-05 on Windows x64, Node.js 24.9.0 and Chrome. This record distinguishes normative/source evidence, generated numerical checks and actual browser behavior. The [linear frame contract](../docs/linear-working-frames.md) owns product behavior; [input color research](float-input-color.md) owns the shared ICC mathematics.

## Primary references

The reviewed [PNG Third Edition, fixed 2025-06-24 Recommendation](https://www.w3.org/TR/2025/REC-png-3-20250624/) defines all legal sample/type combinations, byte filters, Adam7 passes, network-endian words, straight alpha and full-word transparency matching. Color priority is cICP, then iCCP, sRGB, and gAMA/cHRM; sBIT describes significance separately from storage. Zero gAMA is ignored; unused final-IDAT bytes are tolerated. Unknown critical chunks are fatal; damaged palette indexes recover opaque black. Relevant sections: 4.3, 7–11 and 13.1/13.13.

The inspected [libpng 1.6.50 manual](https://github.com/pnggroup/libpng/blob/v1.6.50/libpng-manual.txt) explains preserving/expanding 16-bit samples, interlace handling and explicit CRC policy. Its transform flags distinguish preservation from depth reduction and display/gamma conversion. This was API/source research, not a new linked runtime. The already installed native library used for independent validation is identified separately by the color experiment.

## Existing repository and implementation choice

Source inspection found no PNG pixel decoder in pinned UTIF 3.1.0: neither `decodePNG` nor UPNG exists in the vendored or installed package. exifr's PNG file parser extracts metadata; it neither unfilters nor reconstructs integer pixels. No installed PNG decoder package supplies the needed contract. Libpng/zlib are existing JPEG XL build prerequisites, but the retained build recipe identifies them as absent from its encoder link inputs; this is not a shipped libpng decoding API.

The existing `web/color-containers.js` writer already owns PNG CRC/chunk construction and uses vendored pako 1.0.11. The selected implementation extracts that actual shared responsibility into [png-container.js](../web/png-container.js) and adds [png.js](../web/png.js) for numeric readback through the same pako inflater. No copied decoder, new dependency, source import or binary build is introduced. Production has one CRC implementation and one PNG chunk reader; independent fixture/test CRC is deliberately bitwise so it can check the table-driven production primitive.

Alternatives were an additional UPNG/PNG dependency (not installed, requiring provenance/build work), a new libpng WASM binding (mature decoder but a new runtime and ownership boundary), and the existing browser display decode (already available but measured below to lose low bits). None provides a reason to maintain two production PNG parsers. The new reader's output reuses the existing color adapter, worker lifecycle and Float32 renderer.

## Actual low-bit ablation

The original generated RGB16 fixture is 512×2, tagged sRGB, with red source words 1000–1511, repeated on its second row. Green and blue have matching ramps at higher offsets. An independent filter-zero reference concatenates the fixture's IDAT payloads, inflates through Node zlib and reads network-endian Uint16 words. It supplies a reference independent of the new decoder's pako/filter path.

| Route, actually executed | Distinct red levels | First words/pixels |
| --- | ---: | --- |
| Generated source / independent zlib words | 512 | 1000, 1001, 1002, 1003 |
| New numeric PNG decoder, normalized Float32 then reconstructed words | 512 | Exact source words; maximum error 0 |
| Existing Chrome `createImageBitmap` → canvas `getImageData` | 3 | Repeated `[3,7,11,255]` byte pixels |

The first ignored experiment ran before implementing the decoder and demonstrated the display loss. The maintained [precision experiment](../scripts/experiments/png-precision.mjs) now verifies the production numeric reader as well. Generated files and JSON reports are written only under ignored `.workspace/png-precision/`:

```powershell
node scripts/experiments/png-precision.mjs --browser
```

The browser branch requires installed Chrome and access to its temporary loopback server. Omitting `--browser` explicitly reports display measurement as not run. These numerical results do not establish display accuracy for every PNG profile or platform.

## Numeric reader contract

`readPng(bytes)` accepts an ArrayBuffer or Uint8Array (including sliced views). It returns owned tight `{width,height,data:Float32Array,sourceBits,colorType,metadata}`. RGBA samples are normalized encoded source values with straight alpha. There is no transfer function, gamut conversion, orientation, bitmap, canvas or terminal quantization inside this reader.

- Legal color types 0/2/3/4/6 and their sample depths share one scanline implementation. Filtering operates on bytes before Uint16/packed sample extraction; previous rows reset per Adam7 pass, including passes that are empty at small dimensions. Palette lookup produces 8-bit RGB/alpha precision regardless of index depth.
- Truecolor/grayscale transparency keys compare full original words before normalization. Unused high bits of packed/byte transparency keys are masked. Palette entries omitted from a short transparency table stay opaque. Zero alpha does not erase straight source RGB.
- `metadata.icc` contains decompressed profile bytes; `srgb`, `gamma`, `chromaticities` and `cicp` retain their separate declarations. `colorType` allows the color adapter to distinguish GRAY from RGB profile requirements. cICP range remains numeric 0/1. The shared color owner chooses precedence and capability; the parser does not guess an ICC match or implement a second color engine.
- `significantBits` is separate metadata; the decoder preserves actual stored low bits rather than truncating all samples to an sBIT declaration. `exif` retains owned bare TIFF bytes for the existing EXIF/orientation adapters. `mdcv`/`clli` retain raw mastering/display metadata without treating it as source characterization. The reader validates their lengths and requires cICP with mDCV.

## Integrity and resource behavior

The shared container iterator verifies signature, actual chunk extents, type bytes and CRC before yielding data. Known singleton, length and ordering rules are checked by the numeric reader. Unsupported critical chunks fail visibly; unknown ancillary chunks are skipped after integrity checking. This is PNG's format CRC, not an arbitrary file hash or runtime provenance gate. The input bytes remain immutable.

IDAT/fdAT chunk payloads feed the existing streaming zlib inflater without a full compressed concatenation. The implementation requests a zlib wrapper, verifies actual end-of-stream/Adler completion, and consumes output row by row into the final Float32 result. It does not call finalization in a way that could turn pako's missing-trailer state into success. Emitted byte count must exactly match selected frame/pass geometry. Extra inflated pixels, missing scanlines, invalid filters and truncated zlib trailers fail; valid padding after the final compressed stream records a technical warning and is ignored. Only two scanline-sized buffers and pako's fixed chunks accompany the output frame. Profile decompression still allocates its complete result; memory/runtime constraints remain real.

There is no arbitrary file-size or image-megapixel cap. Bounds enforce the format's representable integers and JavaScript safe arithmetic; typed-array allocation failures remain visible resource errors. Malformed and extreme-memory cases do not authorize substituting fabricated black sample buffers.

The specified palette-index recovery is explicit: an invalid index emits opaque black and increments `metadata.invalidPaletteIndices`, plus unique `png-palette-index` warning. Zero gamma records `png-zero-gamma`; color interpretation handles it as absent. Other invalid interpreted metadata fails visibly. The application exposes meaningful damage/compatibility provenance separately from technical padding diagnostics.

## APNG first-frame evidence

The initial implementation read the static/default IDAT image, but a real browser experiment found that insufficient for existing photo behavior: a red default image excluded from the animation and a green first fcTL/fdAT frame produced green through native Chrome `createImageBitmap`, while the initial reader produced red. The implementation was corrected, rather than keeping that observed mismatch or silently reducing animation input to RGBA8.

The workflow owner also observed actual Chrome applying all eight eXIf orientations. Numeric integration therefore sends the retained bare TIFF metadata through the existing exifr orientation reader and the shared [pixel orientation mapping](../web/pixel-orientation.js), once, after color conversion. `readPng` itself leaves samples in encoded source coordinates. This preserves the existing Chrome display behavior without another TIFF metadata parser or copied orientation algorithm. [The browser input suite](../tests/png-input.test.js) checks both OpenLR display and float decode against independently specified pixel orders and exact low words/alpha; source-file bytes remain unchanged. The cross-engine correction below supersedes the initial assumption that every native PNG decoder applies orientation.

APNG now selects the first animation frame. A control before IDAT selects that default image as frame one; otherwise the first controlled fdAT stream is decoded. The same scanline/filter/Adam7 kernel uses the frame's rectangle and places samples at its offset on the initially transparent IHDR canvas. SOURCE and OVER on that initial canvas retain covered straight samples; uncovered canvas stays transparent. Sequence, control rectangle, operation, declared frame count and payload presence are checked. Metadata reports `animated:true` and `decodedFrame:'animation-first'`. This is first-photo-frame support, not animation playback, editing or validation of every later frame's compressed pixels.

## Executed numerical checks

```powershell
node --test tests/png-layout.test.js
```

The executed ten tests include **720 static cases**: every legal depth/type × all five individual filters plus mixed filters × noninterlaced/Adam7 × dimensions 1×1, 2×3, 9×9 and 17×13. IDAT data is split across seven-byte chunks to avoid assuming chunk/row/deflate alignment. Every resulting normalized sample equals the independently generated expected Float32 value, and original bytes stay unchanged.

They also include **60 APNG first-frame cases**, covering every legal layout with both interlace methods and both first-frame blend modes, subrectangle offsets and split fdAT streams; an IDAT-included first frame; invalid frame controls/sequences; alpha low codes; hidden straight RGB; complete-word and packed transparency; palette recovery; owned metadata; malformed chunks/CRC/filters/streams; valid trailing compressed padding; and a captured pre-extraction PNG writer hash. The old and shared-helper writer serialization matches byte for byte.

The browser/GUI suites and optional independent no-transform libpng/color measurements are maintained by the integration/color owners; their actual results are recorded in their experiment and application acceptance records. These generated checks do not prove arbitrary real PNG provenance, all animation frames, huge-image throughput, other native WebViews or native acceptance.

## Native PNG orientation correction

On 2026-11-05, an actual Ubuntu 24.04 / WSL2 / WebKitGTK 2.52.6 MyGo window at source revision `8ec94b8` imported the generated metadata fixture (32×24, eXIf Orientation 6) as 32×24. Chrome 155 and Windows WebView2 had imported it as 24×32. The Linux native metadata assertion failed before export. This is runtime evidence for those engines, not a claim about every Safari release.

Context7 `/mdn/content` documents `createImageBitmap`'s default `from-image` and the `none` option in the [MDN source](https://github.com/mdn/content/blob/main/files/en-us/web/api/window/createimagebitmap/index.md). [WebKit issue 210021](https://bugs.webkit.org/show_bug.cgi?id=210021) records historical PNG eXIf placement/platform differences; its macOS observations do not establish this Linux result. The [PNG specification](https://www.w3.org/TR/png-3/#eXIf) defines the TIFF payload and cautions that historical metadata can be stale. OpenLR's explicit choice is consistent source orientation between its already-established Linear path and display path.

The executed comparison used unchanged browser-directed PNG decode versus a temporary decode Blob without eXIf followed by the existing pixel permutation. The former failed the Linux orientation assertion; the latter passed eight directions and both processing versions, including TIFF pixel readback and byte-identical originals. The display adapter preserves every other chunk, keeps the host's color management, and does not inflate samples or introduce another EXIF parser. It also serves Linear's explicit display-compatibility path. A separate Chrome comparison against untagged native decode checks exact CMS pixels for sRGB, Display P3 ICC and unsupported CICP across all eight directions. Native-sample Linear precision stays on its original path. `imageOrientation:'none'` was documented but was not used as an unverified cross-engine capability assumption.

Display decoding does not add a CRC acceptance gate: the shared chunk iterator checks extents needed to locate metadata but delegates CRC handling to the host for this path. Numeric PNG reconstruction and export retain their strict default. Invalid EXIF parsing errors remain visible; this change does not invent metadata-recovery rules. Existing recipes retain their coordinates when orientation is corrected, so an old recipe created against a previously misoriented WebKit source can change appearance.
