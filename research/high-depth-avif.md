# AVIF integer decode precision

Investigation: 2026-11-05. This record describes the existing compiled decoder and a small JavaScript API extension. It does not establish that browser display decoding preserves high depth, or implement HDR transfer functions.

## Fixed source evidence

The application already ships a rebuilt libavif 1.0.1 decoder. Its fixed revisions and retained licenses are owned by [the codec recipe](../scripts/codec-color/avif/sources.json) and [the color-binding record](avif-color-binding.md). No library, fixture download, source import or binary rebuild was needed for this experiment.

- [The local binding](../scripts/codec-color/avif/avif_dec.cpp) accepts requested output depths 8, 10, 12 and 16. It initializes an `avifRGBImage`, sets its output depth, calls `avifImageYUVToRGB`, and copies the samples and ICC out of native memory before disposal. Requested depth 16 produces integer `Uint16Array`, because `isFloat` remains false. This is not half-float output.
- [The pinned public API](https://github.com/AOMediaCodec/libavif/blob/d1c26facaf5a8a97919ceee06814d05d10e25622/include/avif/avif.h) defines RGB and alpha as full range. YUV conversion performs depth and limited/full range rescaling.
- [Pinned defaults](https://github.com/AOMediaCodec/libavif/blob/d1c26facaf5a8a97919ceee06814d05d10e25622/src/avif.c) select RGBA with `alphaPremultiplied=false`, `ignoreAlpha=false`, and `isFloat=false`. [Pinned conversion](https://github.com/AOMediaCodec/libavif/blob/d1c26facaf5a8a97919ceee06814d05d10e25622/src/reformat.c) detects associated source alpha and unpremultiplies when returning this straight-alpha output. Zero associated alpha yields zero RGB; opaque alpha requires no division. RGB is clamped to the integer output range.
- `avifImageYUVToRGB` applies the source matrix coefficients and YUV range, not ICC gamut/TRC conversion. [libavif's CICP guidance](https://github.com/AOMediaCodec/libavif/wiki/CICP) makes ICC authoritative for RGB interpretation after the YUV matrix has been applied; otherwise CP/TC describe the remaining RGB interpretation.

Context7 `/aomediacodec/libavif` was consulted for RGB depth rescaling, defaults, CICP and ICC precedence. Its current-main snippets include API evolution beyond this pinned version; the local fixed source and real shipped WASM determine the results below.

## Result contract and integration boundary

`decodeAvif(bytes, bitDepth = 8)` in [the adapter](../web/color-codecs.js) now forwards an explicit output depth. The default remains 8. Depth 16 needs no C++ or WASM change. A null decoder result becomes the existing visible `Invalid AVIF image` failure.

| Field | Meaning |
| --- | --- |
| `data` | Owned, tightly packed straight RGBA; `Uint8ClampedArray` for output 8, `Uint16Array` for output 10/12/16 |
| `width`, `height` | Decoded pixel dimensions |
| `bitDepth` | Requested output depth; normalize every channel by `2 ** bitDepth - 1` |
| `sourceBitDepth` | Actual `avifImage.depth`, independent of the requested output depth |
| `icc` | Owned exact embedded ICC bytes, or an empty `Uint8Array` |
| `colorPrimaries`, `transferCharacteristics` | Source RGB CP/TC; no transfer decoding or gamut conversion has happened |
| `matrixCoefficients`, `fullRange` | Source YUV metadata; the decoder already used these for RGB reconstruction |

For requested depth 16, divide both RGB and alpha by **65535**, not 1023 or 4095. Returning 16-bit storage does not manufacture 16-bit source precision. The source-depth field must remain part of provenance. The matrix and YUV range must not be applied twice.

High-depth integration must feed these native samples directly into a numeric ICC/CICP conversion before creating the linear working frame. The display path through tagged PNG, `ImageBitmap`, canvas and byte `getImageData` cannot serve as evidence of retained low bits. Supported SDR CP/TC combinations can use explicit transfer/primary conversion; PQ, HLG and other unsupported transfers need explicit compatibility provenance until their numerical conversion is implemented. Reading their tags successfully is not HDR processing support.

## Executed experiments

```sh
node scripts/experiments/avif-depth.mjs
node --test tests/avif-depth.test.js
```

The [experiment](../scripts/experiments/avif-depth.mjs) uses the shipped encoder and decoder modules with generated 64×64 integer RGBA ramps at source depths 8, 10 and 12. It encodes lossless identity/4:4:4/full-range AVIF and independently reads actual BMFF `pixi` channel depths. Every input is decoded at requested depths 8, 10, 12 and 16. It verifies exact embedded Display P3 ICC, CP/TC/MC/range `12/13/0/full`, owned results surviving later decodes, unchanged original sample/byte buffers, corrupt-input rejection and invalid-depth rejection. Generated AVIFs and a machine-readable report go only to ignored `.workspace/high-depth-avif/`.

| Measurement | Source 8 | Source 10 | Source 12 |
| --- | ---: | ---: | ---: |
| Native source-depth RGBA maximum difference | 0 | 0 | 0 |
| Output-16 maximum difference from ideal double-precision rescaling | 0 | 1 | 1 |
| Source code 1 returned at output 16 | 257 | 64 | 16 |
| Source code 2 returned at output 16 | 514 | 128 | 32 |
| Associated-alpha output-16 difference from ideal straight RGBA | 0 | 1 | 1 |

The rescaling reference is `round(source * outputMax / sourceMax)`. Native float arithmetic can move a value across a rounding boundary: source 10-bit code 820 produces 52531 at output 16, while JavaScript double arithmetic rounds to 52530. Thus the real full-ramp measurement supports a one-output-code tolerance, not a universal exact-rounding claim. The 10/12-bit low samples remain clearly distinct where 8-bit output collapses them.

Straight source alpha retains the source RGB even beneath alpha zero; it is not accidentally premultiplied. Associated-alpha fixtures reuse the generated coded samples and add the standard `prem` item reference from color to alpha, updating `meta`/`iref` sizes and `iloc` extents. Actual WASM then returns straight RGB within one 16-bit code of the explicit division reference and zero RGB at alpha zero. Inputs above their alpha exercise native clamping as well. This patcher is deliberately limited to the generated single-image version-0 box layout, not a production BMFF writer or a generic validator.

Separate no-ICC 10-bit fixtures with CP/TC `1/13`, `9/16` and `9/18` return the same normalized encoded RGB ramp (within one 16-bit code), preserving the distinct tags. This verifies that the native decoder does not secretly apply sRGB, PQ or HLG transfer decoding.

[The automated checks](../tests/avif-depth.test.js) run the numerical experiment in Node and verify the public adapter in real headless Chrome: default output stays byte RGBA, explicit 16 gives integer RGBA16 and source depth, ICC/CICP remain exact, and input samples/bytes remain unchanged. Executed on Windows, Node 24.9.0 and Chrome 155. Initial sandboxed loopback navigation failed with `ERR_NETWORK_ACCESS_DENIED`; the same tests passed after allowing Chrome to access the local test server. The Node numerical test already passed within the sandbox.

The inspected decoder WASM was 1,158,246 bytes, SHA-256 `b899b4879d8f9683feb478eab64f9ebe4dab14121cb7a7bd0f42bb9c348382b1`. These small generated fixtures validate this binding's sample and metadata contracts. They do not establish arbitrary lossy/chroma-subsampled reconstruction accuracy, container orientation handling, AVIF animation, ICC transform coverage, real HDR tone mapping, large-image memory behavior or other operating-system/WebView acceptance.

## Working-frame integration checks

After the high-depth adapter was connected to `decodePhotoFrame`, [AVIF input tests](../tests/avif-input.test.js) exercised the complete codec-worker route with generated 10/12-bit files. They compare unprofiled sRGB values with the explicit sRGB transfer equation; both low RGB codes and low alpha coverage survive, including nonzero straight RGB beneath zero alpha. Embedded matrix/TRC Display P3 and no-ICC CICP Display P3 both produce the expected out-of-sRGB red near `[1.224745, -0.042058, -0.019642]` instead of clipping it to the display gamut. This exercises actual profile and CICP interpretation in the working path, separately from the decoder's native-value measurements above.

The tests also verify actual malformed-profile/corrupt-input errors, recovery, unchanged original bytes, and exact normal-worker versus forced startup-fallback frame equality. An unsupported PQ CICP input exposes `rgba8-display` provenance, `avif-cicp` compatibility reason and the true 10-bit source depth; it is not counted as high-depth HDR processing.

The GUI workflow imports a generated 12-bit AVIF, selects Linear through its processing control, checks state and the 12-bit Info text, exports true TIFF16, checks low source bits within one display byte, and reloads the original AVIF with identical export samples. It then reimports that TIFF, enables Linear, reexports and reloads with 16-bit provenance. Output samples are checked against the known source codes (maximum accepted error two TIFF16 codes; the additional ICC reimport/export allows three codes). The GUI's unsupported-CICP case displays the explicit 8-bit compatibility text. Run:

```sh
node --test tests/avif-depth.test.js tests/avif-input.test.js
```

This extends browser integration evidence; it does not establish native-host or other-platform acceptance.
