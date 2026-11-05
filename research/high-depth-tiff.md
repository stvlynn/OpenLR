# TIFF integer precision investigation

Investigated on 2026-11-05 on Windows with Node.js 24.9.0. This record describes pinned-source inspection and synthetic numeric experiments; it does not establish a requirement to support every TIFF layout or validate physical-camera files.

## Evidence and provenance

The existing runtime dependency is UTIF npm 3.1.0, git revision `27f1098a67c3cfd4348c9b8fd887fcd8cd171095`. The inspected [vendored ESM wrapper](../web/vendor/codecs/utif.js) has SHA-256 `20cdd625ff0fa25e5f02904ed8bd23647635163ac0c0fd171280006521da3e8f`; its unchanged dependency body, MIT license and Photopea copyright remain recorded in [image codecs](../docs/image-codecs.md) and [third-party notices](../THIRD_PARTY_NOTICES.md). No external TIFF parser or codec is introduced by this investigation.

The experiment is independently authored project code at ignored `.workspace/tiff-precision-experiment.mjs`, with results at `.workspace/tiff-precision/results.json`. It writes small classic-TIFF containers from generated integer arrays, separately constructs predictor deltas and compressed streams, invokes the actual vendored `UTIF.decode` / `UTIF.decodeImage`, and compares every decoded sample against the pre-encoding integer array. It also checks original input bytes are unchanged. Node's built-in zlib supplies Deflate; a literal-run PackBits encoder and literal-only early-change LZW encoder generate the other compressed fixtures. Initial LZW fixtures cleared before nine-bit code-width growth; the extended experiment now exercises nine through twelve-bit transitions. It does not exercise compressed dictionary-string references or every code-table edge case. No photographs, external binary fixtures or third-party writer implementation are used.

Attempts to fetch the fixed upstream README and the OSGeo TIFF 6 PDF through the research browser failed (cache miss / HTTP 403). Conclusions below therefore cite the actual pinned source rather than claiming a fetched specification was reviewed.

## Actual UTIF buffer contract

`UTIF.decode` parses the existing TIFF IFDs. `decodeImage` lines 104–157 allocates the decompressed image buffer, decompresses strips or tiles, and assigns an owned byte view to `image.data`. It neither performs orientation nor converts ordinary RGB or grayscale samples to a working color space. `toRGBA8`, lines 986–1050, is a separate lossy display conversion.

For ordinary unsigned 16-bit TIFF, `_decompress` lines 185–190 swaps big-endian byte pairs to **little endian** before horizontal predictor reconstruction. Consequently `image.isLE` still describes the input file header and must **not** determine the byte order used to read `image.data`. Read normalized samples with `new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength).getUint16(offset, true)`. This statement excludes sensor/DNG paths: the swap explicitly skips `t33422` CFA metadata. Sensor DNG must retain the RAW decoder route.

The decoder reconstructs horizontal predictor 2 in the same integer sample domain; 16-bit additions wrap modulo 65536. An adapter must not apply the predictor a second time. Predictor 3 is not implemented by this branch and must not be accepted as equivalent to 1. UTIF may merely log unrecognized compression and return zero-filled bytes, so an adapter must explicitly allow only encodings it intends to support; the mere presence of an output buffer is insufficient evidence of support.

For the tested stripped RGB and grayscale layouts, samples remain interleaved in channel order. Uniform `BitsPerSample` 8 or 16 with chunky `PlanarConfiguration=1` therefore admits an exact numeric adapter:

1. Validate classic-TIFF header, dimensions, uniform channel bit depths, unsigned `SampleFormat=1`, photometric interpretation, channel count, alpha declaration, predictor/compression and strip metadata before calling the existing decoder. Reject sensor DNG, floating/signed samples, separate planes, unsupported compression/predictors, and contradictory or incomplete layouts visibly.
2. Decode with the existing UTIF parser and decompressor. Read 8-bit samples directly or normalized little-endian 16-bit samples using the view above; normalize by 255 or 65535 respectively.
3. RGB uses three channels, optionally followed by one declared associated/unassociated alpha. Grayscale uses one channel, optionally followed by one declared alpha; replicate its color into RGB. WhiteIsZero requires inversion of the grayscale color value. Alpha is coverage and is neither inverted nor transfer-decoded.
4. Convert associated colors to straight colors at full precision before a nonlinear transfer/color transform. Handle zero alpha explicitly. Keep unassociated samples independent of alpha. Determine the source transfer/color transform from the existing color adapter contract; TIFF bit depth alone does not imply linear light.
5. Apply orientation by copying whole RGBA sample tuples using the existing orientation mappings (1–8), preserving numeric sample values and swapping dimensions for 5–8. Do not route these samples through `ImageData`, a bitmap or canvas before creating the float frame.

The adapter must validate every per-channel field, not just `BitsPerSample[0]` or `SampleFormat[0]`. UTIF derives bits-per-pixel from the first bit depth multiplied by the field's element count, so accepting inconsistent metadata cannot provide a reliable numeric contract.

Legacy `toRGBA8` visibly discards the low byte of RGB16 and BlackIsZero16. Its WhiteIsZero branch has no 16-bit implementation. Its grayscale paths assume one color channel and do not preserve grayscale alpha. Those source observations support reading decompressed samples directly for the new precision path; they do not justify changing existing legacy display output in this task.

## Executed matrix

Command actually executed:

```powershell
node .workspace/tiff-precision-experiment.mjs
```

| Generated cases | Result | Scope |
| --- | --- | --- |
| 160 stripped cases | 160 exact, 0 failures | 8/16 bits × little/big endian × uncompressed (1), LZW (5), Deflate (8), PackBits (32773) × predictor 1/2 × RGB, RGBA, WhiteIsZero grayscale, BlackIsZero grayscale, BlackIsZero grayscale+alpha |
| 128 tiled RGB cases | 57 exact, 71 failures | Same bit depths, endian modes, compressions and predictors; 16×16 tiles in images 17×18, 5×4, 32×32 and 33×2 |

Stripped fixtures use two rows per strip in 5×4 images and nonzero low bits, with alternating high/low-byte patterns. Exact equality is checked before any transfer function or alpha/color interpretation. Their alpha channel is declared unassociated and includes zero and fractional coverage. This matrix proves decompressed buffer preservation in these synthetic cases, not the subsequent alpha, ICC or orientation adapter. Those need executable tests against the implemented adapter.

## Tile and malformed-data limits

The tiled failures are concrete upstream behavior, not a reason to write a second TIFF decoder:

- `_decompress` calculates endian-swap/predictor row width from the full image width and row count from RowsPerStrip/image height, even when its destination is a tile buffer. All 64 generated predictor-2 tile cases failed when image width differed from tile width.
- On a single uncompressed tile, `decodeImage` overrides its byte count with the image's unpadded decoded size. A 5×4 image in a padded 16×16 tile therefore copies too little tile storage. All four generated uncompressed predictor-1 tiny-tile cases failed.
- Big-endian 16-bit tiny compressed tiles additionally leave needed padded-row byte pairs unswapped; three generated predictor-1 cases failed.

The initial conservative recommendation was to reject tiles until those defects were fixed. The minimal shared-codec repair below supersedes that recommendation: the same existing UTIF decoder can support the tested tiled layouts without an additional TIFF parser. Falling back to an 8-bit display decoder and labeling its result high precision is not justified.

`_decompress` line 164 also treats a compressed block as raw if its compressed byte count equals the destination buffer's total byte length (except ARW). The experiment did not exercise that equality case. An adapter must account for this source-observed ambiguity rather than claiming that every compressed stream is validated. Compression 32946 is not present in the pinned dispatch; do not infer support from the alternate Deflate tag's existence elsewhere.

Source inspection also shows UTIF's allocation/output length alone cannot establish decoded completeness: some corrupt compressed streams can leave zeros in preallocated storage. Header/strip offset/count bounds and uncompressed expected sizes should be validated. Comprehensive malformed compressed-stream validation and arbitrary TIFF interoperability remain beyond this experiment's evidence.

## Experimental shared-decoder repair

The experiment can make a separate ignored copy of the pinned UTIF module and apply three exact, count-checked source replacements. The production vendored file was not edited for this experiment:

1. In `decodeImage`, apply the uncompressed single-block byte-count override only when `image.t322` (TileWidth) is absent. This retains strip behavior and preserves the full declared padded tile storage.
2. In `_decompress`, prefer TileLength (`t323`) for the block's row count and TileWidth (`t322`) for its byte stride. Otherwise retain RowsPerStrip/image dimensions. This corrects the existing endian/predictor loops; it adds no new decoding algorithm.
3. Copy raw bytes only for `compression===1`. Remove the compressed-size-equals-destination-size shortcut so actual compressed streams always enter their existing codec branch.

The exact experimentally verified replacements are:

```js
// decodeImage
if(cmpr==1 && soff.length==1 && img["t322"]==null) bcnt = [img.height*(bipl>>>3)];

// _decompress dispatch
else if(cmpr==1) for(var j=0; j<len; j++) tgt[toff+j] = data[off+j];

// _decompress block dimensions
var noc = (img["t277"]?img["t277"][0]:1), bpp=(bps*noc)>>>3,
    h = (img["t323"] ? img["t323"][0] : img["t278"] ? img["t278"][0] : img.height),
    bpl = Math.ceil(bps*noc*(img["t322"] ? img["t322"][0] : img.width)/8);
```

Command actually executed:

```powershell
$env:TIFF_PATCH='1'
node .workspace/tiff-precision-experiment.mjs
```

The extended matrix contains **160 stripped and 896 tiled cases; all 1,056 decoded exactly** with the experimental repair. The tiled matrix adds RGB, RGBA with either alpha declaration, WhiteIsZero and BlackIsZero grayscale, and BlackIsZero grayscale+alpha with either alpha declaration. Each layout covers both bit depths/endian modes, all four compressions, both predictors and all four image/tile dimension cases above. The alpha declarations here test raw sample preservation, not valid premultiplied color generation or the subsequent straight-alpha conversion. The extended unpatched matrix has 497 failures among 896 tiled cases; strips remain exact.

If incorporated, the patch belongs in the existing vendor generation flow (`scripts/build-codecs.mjs` → `scripts/vendor-codecs.mjs`), with exact expected-source checks so an upstream update cannot silently retain an inapplicable patch. Change the wrapper's unmodified-source claim, retain the MIT notice, identify the local changes/date, refresh the existing manifest, and update the existing provenance records. This is a proposal supported by experimental decoding, not a claim that the production vendor file has already changed.

One further source-observed limitation needed explicit treatment in production: upstream `_decodeLZW` takes no compressed byte length and loops until an EOI code with no input boundary. Missing-EOI input can outlive valid compressed data; the Worker runner's timeout cannot interrupt synchronous main-thread fallback. Passing the existing block length into that same decoder and checking code reads/output extent is a targeted correction within the dependency, not a reason for a second LZW implementation.

## Incorporated shared-codec changes and verification

The three experimental fixes are incorporated through [the source-checked vendor patch](../scripts/patch-utif.mjs) called by the existing [vendor script](../scripts/vendor-codecs.mjs); `build-codecs.mjs` already calls that script and needs no parallel build route. The generated UTIF module marks these changes dated 2026-11-05 and retains upstream licensing. The original inspected SHA-256 above identifies the pre-patch evidence; the existing runtime manifest identifies the generated result.

The patch also passes each declared compressed block length into the existing LZW decoder, checks input bit bounds before ordinary and post-clear code reads, rejects invalid initial/dictionary codes, and checks decoded output extent/completeness. Missing EOI and truncated input therefore fail visibly. It does not add a separate LZW decoder or TIFF parser.

The reproducible numeric experiment is now [scripts/experiments/tiff-precision.mjs](../scripts/experiments/tiff-precision.mjs), using [independently authored generated fixtures](../tests/fixtures/tiff.mjs) with optional numeric samples, ICC bytes and orientation tags. It writes results to ignored `.workspace/tiff-precision/production-results.json`. Actual command `node scripts/experiments/tiff-precision.mjs` reported `{"cases":1056,"exact":1056}` against the generated production decoder.

`node --test tests/tiff-layout.test.js tests/float-tiff.test.js` actually passed ten tests on Windows/Node 24.9.0: the 1,056 numerical cases, bounded malformed LZW cases inside an isolated Worker (so a regression cannot hang the test process), malformed block completeness, padded final strips, the compressed-size-equals-decoded-size case, deterministic generation/source-mismatch rejection, and existing TIFF16 output and legacy serialization checks. Arbitrary TIFF interoperability and the subsequent float color/orientation adapter require their own coverage.

Before the final bounds changes, generated files reproduced three silent corruption cases: an uncompressed file truncated by five bytes; a valid Deflate stream inflating to three bytes instead of the required 120; and a valid PackBits literal stream producing three bytes instead of 120. Each was accepted with zero-filled sample tails. The shared patch now validates each block's declared input extent, uncompressed length, actual Deflate output length, and PackBits input-run and decoded-output lengths. LZW output checks use the same block geometry. The final strip can contain exactly the remaining rows or a complete padded RowsPerStrip block; tests cover both, across all four compressions and both sample depths. No file-size ceiling is introduced.

The removed compression shortcut also has a concrete valid fixture: sixteen grayscale bytes containing six deterministic pseudorandom values followed by zeros compress to exactly sixteen Deflate bytes. The old branch copied compressed bytes as pixels; the generated regression now verifies the correct original samples.

Actual browser compatibility command `node --test tests/codecs.test.js tests/worker-fallback.test.js` passed four tests on Windows/Chrome, including TIFF alpha/orientation/Deflate round trips and real Worker construction/module-load fallback. The first sandboxed run failed all three browser-navigation tests with `net::ERR_NETWORK_ACCESS_DENIED` at their temporary loopback servers. Rerunning the same command with approved local-network access passed; the initial failure was not a decoding result.
