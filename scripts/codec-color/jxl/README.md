# JPEG XL bindings

The [shared codec recipe](../README.md) activates the pinned Emscripten 3.1.64 toolchain. `sources.json` fixes libjxl and its existing Brotli, Highway and skcms inputs. No new dependency or codec source is fetched for high-precision input.

```sh
source scripts/codec-color/environment.sh
bash scripts/codec-color/jxl/build.sh
node scripts/codec-color/install.mjs
```

The scalar build produces the production `jxl_color_enc` and `jxl_color_dec` modules, plus validation-only `jxl_inspect` and `jxl_input_fixture`. Only the production modules are installed under `web/vendor/codecs/jxl/`. The fixture encoder and inspector remain ignored build outputs. Existing pthread/SIMD build variants apply to the encoder; the production decoder is scalar and runs through the application's existing short-lived Worker/fallback boundary.

The installer requires all production builds before replacing assets. It removes the former published decoder, its JavaScript wrapper and helper. `scripts/vendor-codecs.mjs` preserves the rebuilt decoder during ordinary offline dependency refreshes, retaining the package/component licenses and refreshing the existing provenance inventory. A validation reference copy of the former decoder may be kept only under ignored tooling paths; it is not a second shipped decoder.

## Decode contract

`jxl_decode_core.h` owns one public-libjxl decode loop shared by the production byte and working routes and the native-FLOAT inspector. It requests `JXL_TYPE_FLOAT`, queries the **DATA** ICC/structured encoding separately from ORIGINAL, preserves source bit/exponent and intensity metadata, applies libjxl's default codestream orientation/coalescing, and stops at the first full display image. It does not infer that FLOAT output has a linear transfer function or that ORIGINAL ICC describes the decoded samples.

The production module exposes:

- `decode(bytes)`: owned byte RGBA plus dimensions/metadata. It preserves the former published decoder's DATA-ICC-to-sRGB skcms conversion and terminal quantization policy. The adapter creates `ImageData`; the binding itself works in Node without an `ImageData` global.
- `decodeWorking(bytes)`: owned straight RGBA `Float32Array` in linear sRGB when the measured native skcms conversion can represent the data. It uses a copy of the existing skcms sRGB destination profile with an identity transfer function and a FLOAT destination. It preserves signed/HDR RGB rather than passing through the byte route.
- Explicit compatibility results from `decodeWorking` contain byte RGBA, `colorSpace:'srgb'` and a reason. Structured PQ/HLG yields `jxl-hdr-transfer`; samples outside the normalized RGB domain combined with a bounded table/LUT profile yield `jxl-profile-range`. XYZ `mft1` LUTs, whose PCS encoding is not standardized by ICC, yield `jxl-profile-unsupported`. Compatibility uses the same already-decoded native samples and the shared legacy conversion, without a second decompression.

Both routes return copied ORIGINAL/DATA ICC and available structured encodings, `sourceBits`, `sourceExponentBits`, alpha depth/exponents and source association, `usesOriginalProfile`, intensity parameters, channel counts and animation/orientation information. `profileTransform` distinguishes an A2B0 LUT from matrix/TRC conversion. The application retains only appropriate metadata in state, not profile byte arrays. Decode/transform failures return null for the JavaScript adapter to report visibly.

The working path corrects a measured pinned-skcms XYZ LUT normalization defect. For selected `mAB` XYZ profiles it removes the prematurely inserted PCS scale from all twelve parsed matrix coefficients when that stage exists, then applies `65535/32768` to final linear RGB after B curves. For selected `mft2` XYZ profiles it applies that final scale. Alpha and the legacy byte route are unchanged. The existing CMS tag accessor identifies the same A2B0-otherwise-A2B1 selected by the successful pinned parser; a malformed existing A2B0 causes parse failure rather than fallback to A2B1. No second ICC directory parser is introduced. Actual identity and nonlinear B-curve measurements against Little CMS own the evidence; `profileCorrection:'xyz-lut-output-scale'` records this adjustment.

## Validation tools and provenance

`jxl_inspect.inspectFloat(bytes)` returns native FLOAT samples before CMS, together with ORIGINAL/DATA profiles and source metadata. Its older `inspect` entry retains the UINT8 native inspection contract for the existing encoder experiments.

`jxl_input_fixture.encodeFixture(buffer,width,height,icc,options)` accepts packed UINT16 bytes, or packed FLOAT32 bytes when `exponentBitsPerSample` is nonzero. Required options are `bitsPerSample`, `exponentBitsPerSample`, `numColorChannels`, `alphaBits`, `alphaExponentBits`, `alphaPremultiplied`, `usesOriginalProfile`, `orientation`, `structuredTransfer`, `intensityTarget`, and `lossless`. A negative structured transfer selects the supplied ICC; 8/13/16/18 select structured linear sRGB/sRGB/PQ/HLG. This pinned encoder's `SetBasicInfo` auto-alpha path ignores its basic alpha association field, while `AddImageFrame` imports straight input. For associated fixtures the generator queues the supplied associated values under temporary straight metadata, then explicitly sets shared extra-channel association before `ProcessOutput`; actual decoder metadata and native samples verify the resulting file. No pinned or production encoder source is patched. `encodeAnimationFixture()` produces a small two-frame red/green fixture. These APIs are validation tooling, not high-depth product export support.

The new C++ bindings are independently written OpenLR source using public libjxl/skcms APIs and the existing pinned CMS's internal tag accessor for the normalization correction. The legacy rendering policy was inspected in fixed [jSquash decoder source](https://github.com/jamsinclair/jSquash/blob/1b1964194611ece3ec984ab91c04726d1088f05e/packages/jxl/codec/dec/jxl_dec.cpp); its expressive implementation was not copied. Existing jSquash Apache-2.0 notices remain retained. The compiled libraries retain the licenses already inventoried under `web/vendor/codecs/notices/`. Linking reuses libjxl's bundled `jxl_skcms_*` objects through its fixed symbol-renaming header; it does not compile a second CMS implementation.

Actual source/profile, precision, legacy byte and alpha results belong to [the high-depth investigation](../../../research/high-depth-jxl.md) and [the independent color experiment](../../../research/jxl-input-color.md). Successful compilation alone does not establish color/HDR correctness or cross-platform native acceptance.
