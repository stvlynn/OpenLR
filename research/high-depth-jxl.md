# JPEG XL float decode contract

Investigated on 2026-11-05. This record distinguishes fixed-source inspection, actual existing-WASM results and proposed integration. It does not establish native acceptance, general HDR tone mapping or arbitrary codec/profile interoperability.

## Pinned sources and discovery

OpenLR's existing JPEG XL build uses libjxl `9f544641ec83f6abd9da598bdd08178ee8a003e0` (reported public version 7000), with skcms `64374756e03700d649f897dbd98c95e78c30c7da`. Exact archives, dependencies and retained terms belong to [the existing source inventory](../scripts/codec-color/jxl/sources.json), [binding research](jxl-color-binding.md) and [third-party notices](../THIRD_PARTY_NOTICES.md). Both source trees are already present under ignored `.tools/codec-color/jxl/source/libjxl/`; no new source dependency was fetched for these local inspections.

The [fixed decoder header](https://github.com/libjxl/libjxl/blob/9f544641ec83f6abd9da598bdd08178ee8a003e0/lib/include/jxl/decode.h), [sample type header](https://github.com/libjxl/libjxl/blob/9f544641ec83f6abd9da598bdd08178ee8a003e0/lib/include/jxl/types.h) and [basic-info header](https://github.com/libjxl/libjxl/blob/9f544641ec83f6abd9da598bdd08178ee8a003e0/lib/include/jxl/codestream_header.h) define the public contract. The locally inspected `decode.h` has SHA-256 `bd3e60a83ebc00f3dc8e1a5dd3f0103ce682c1a5f5ab22ddea3837d0580caa59`. Browser fetches of those fixed raw URLs returned cache misses; the pinned local archive, not a current-main snippet, supplies the version-specific evidence below.

Context7 `/libjxl/libjxl` was consulted for API discovery. Its current-main format overview describes normalized orientation/compositing and distinguishes original-profile samples from XYB output. It also documents newer output-color/CMS APIs added in 0.9. Those newer APIs must not be assumed available in the pinned 0.7 build. The exact [published jSquash decoder wrapper](https://github.com/jamsinclair/jSquash/blob/1b1964194611ece3ec984ab91c04726d1088f05e/packages/jxl/codec/dec/jxl_dec.cpp) was successfully read through the GitHub connector at its fixed npm revision.

## The existing byte decoder already contains float samples

The published wrapper requests `{4,JXL_TYPE_FLOAT,JXL_LITTLE_ENDIAN,0}` from libjxl. It queries the **DATA** ICC, obtains the first full display image, then calls linked skcms from RGBA float into sRGB RGBA8. Its public JavaScript result is byte `ImageData`; that final CMS/output boundary discards low bits and clips wide colors. Merely changing a JavaScript array type after this call cannot restore them.

At the start of this increment, the OpenLR validation inspector instead requested `JXL_TYPE_UINT8` and returned literal pixels with ORIGINAL and DATA ICC. It was useful for sample/profile evidence but could not prove Float32 preservation. It also looped until overall success rather than stopping at the first full frame. The maintained inspector now has native-FLOAT inspection using the shared first-frame decode core; the initial byte probe below remains distinguished from that later evidence.

An actual Node/WASM probe used the existing production encoder, published decoder and validation inspector. It generated 3×1 lossless RGBA8 images, retaining invisible samples, with the same literal source components under different generated ICCs. No source pixel relabeling was used after encoding. Results were:

| Embedded profile | Inspector literal first RGB | Published display first RGB | Hidden RGB at alpha zero, inspector → display |
| --- | --- | --- | --- |
| sRGB | 180,60,40 | 180,60,40 | 70,80,90 → 70,80,90 |
| Display P3 | 180,60,40 | 196,47,27 | 70,80,90 → 68,80,91 |
| ProPhoto RGB | 180,60,40 | 255,0,44 | 70,80,90 → 70,101,111 |

All three actual codestreams reported `usesOriginalProfile:true`, eight source bits, exact intended ORIGINAL/DATA ICC and byte-exact literal samples. Original encoded bytes remained unchanged. The ignored original probe is `.workspace/jxl-source-inspector.mjs`, with JSON at `.workspace/jxl-precision/source-inspector.json`. These are existing byte-path measurements, not evidence of high-depth JXL source encoding or float output preservation. They show why a host-tagged-PNG replacement should not be assumed pixel-equivalent to the existing skcms display route.

## Actual profile versus preferred profile

`JxlDecoderSetPreferredColorProfile` in this pinned API is conditional. The public decoder header, lines 708–746, explicitly limits the effective preference to cases where the decoder has a choice: principally XYB/`uses_original_profile=false` with an original ICC whose exact structured fields are unavailable. Original-profile data and many recognized structured encodings retain their own data space even if a linear-sRGB preference call returns success.

The implementation reinforces the distinction: `OutputEncodingInfo::Set` in `lib/jxl/dec_xyb.cc` chooses the original structured encoding when supported, otherwise its default; non-XYB data keeps the original encoding. `GetColorEncodingForTarget` in `decode.cc` returns this actual output encoding for DATA and the source metadata for ORIGINAL. Its format parameter is not a universal request to reinterpret samples as linear sRGB.

Therefore a wrapper must query actual DATA ICC/structured encoding **after** any preference call. ORIGINAL is provenance; DATA describes returned pixels. A float output type alone implies neither linear light nor sRGB primaries. Applying ORIGINAL to pixels whose DATA space differs, or unconditionally applying an sRGB transfer to original linear pixels, produces a real color error.

## Float, alpha, orientation and frame semantics

The pinned `dec_external_image.cc` has separate external output paths. `JXL_TYPE_FLOAT` writes actual 32-bit values with `StoreFloatRow`; integer conversion explicitly clamps and quantizes. Missing alpha is synthesized as one. `JxlBasicInfo` describes original color/alpha bit depth and exponent bits independently of requested external storage; returning Float32 does not invent a 32-bit source.

Associated source alpha is already undone in `ConvertToExternal`: it copies the color plane and calls the existing `UnpremultiplyAlpha` before interleaving. The pinned `alpha.cc` uses `1/max(2^-26,alpha)`, including tiny/zero coverage. There is no public `JxlDecoderSetUnpremultiplyAlpha` in this old version. A working adapter must not divide again or assume zero-alpha RGB was forced to zero. Valid straight hidden RGB remains meaningful source data. The published wrapper nevertheless marks skcms input premultiplied when the basic-info source flag is set; that can double-apply alpha handling. Preserve captured legacy behavior separately from a correctly straight working contract, and demonstrate associated-alpha behavior with actual encoded fixtures.

Default `JxlDecoderSetKeepOrientation(false)` applies codestream orientation; returned basic-info dimensions are adjusted and orientation is identity. Do not apply container EXIF orientation afterward. The source metadata's orientation, if needed for provenance, requires an explicit keep-orientation inspection separate from the oriented output; it cannot be inferred from already normalized basic info.

Default coalescing returns composited full-canvas display frames, including required internal zero-duration layers. Stop after the first `JXL_DEC_FULL_IMAGE` for the existing still-photo first-frame behavior. `JXL_DEC_FRAME` identifies displayed frames with coalescing enabled, rather than every internal frame. A container's first compressed layer is not necessarily the first display image. Animation playback and arbitrary extra-channel editing remain outside the still-image contract.

`intensity_target` is a declared intensity upper bound in nits and is already used by the pinned XYB/output reconstruction. It is neither a bit-depth field nor an instruction to multiply every returned RGB value by that number. Record it together with exponent bits, original-profile/animation flags and actual output characterization; avoid declaring a generic HDR editing pipeline solely because those tags exist.

## Best reuse candidate and alternatives

The strongest integration candidate is one rebuilt decoder binding with a shared public libjxl event/buffer loop for both display and working operations, replacing the published decoder binary. Keeping an old full codec plus a separate working codec would duplicate the same implementation and increase source/runtime maintenance. The existing encoder variants remain independent of this decoder choice.

The linked pinned skcms is already the actual input-profile CMS. It can accept RGBA float and emit RGBA float into a linear-sRGB destination built by copying `skcms_sRGB_profile()` and installing `skcms_Identity_TransferFunction()` with `skcms_SetTransferFunction`. Its `skcms.cc` only inserts terminal gamut/range clamp for normalized/integer output formats, not `RGBA_ffff`; source matrix/TRC paths and floating destinations therefore have a viable unbounded route. CLUT interpolation has its own bounded input domain, which remains a profile limitation rather than a reason to label every float operation lossless.

This candidate needs actual signed/highlight/low-bit, profile, alpha and independent color measurements before product claims. It avoids a new JS ICC interpreter for JXL, a second CMS dependency and guesses about preferred output color. Unsupported profiles/transfers still need visible capability handling and honest provenance; native float is not a proof that every ICC curve or HDR transfer has the desired semantics.

Alternatives considered:

- Return FLOAT plus DATA characterization to the shared JS matrix/TRC owner. This preserves the raw samples and a single domain color implementation, but its unsigned input contract must not be silently extrapolated to arbitrary signed original ICC samples or LUTs.
- Assume preferred linear sRGB and skip DATA queries. Rejected by the pinned API and implementation; success of the preference call is insufficient.
- Keep the published byte decode and lift bytes into Float32. Rejected by its terminal skcms RGBA8 boundary; original source precision and gamut cannot be recovered.
- Build a second working-only decoder beside the existing one. It can preserve legacy behavior but duplicates the codec binary and lifetime/build paths; a shared rebuilt loop with explicit policies is preferable when measured legacy samples agree.
- Upgrade libjxl to use newer universal output-CMS APIs. This adds a separate codec migration and provenance/interoperability change; it is unnecessary to evaluate the already linked float CMS path first.

## Implemented boundary and actual high-depth results

The selected candidate is implemented in [the shared public-API decode core](../scripts/codec-color/jxl/jxl_decode_core.h) and [the rebuilt binding](../scripts/codec-color/jxl/jxl_color_dec.cpp). One installed decoder exposes the captured legacy float-to-byte policy and the working float-to-linear-sRGB policy. The old published decoder is no longer a production asset; its installed npm package/ignored copy remains a validation reference. The existing build/install/vendor owners reproduce the new module and preserve component notices. No second codec implementation, replacement color engine or arbitrary image-size gate is introduced.

Working results use `colorSpace:'srgb-linear'`, owned RGBA Float32 and `colorTransform:'skcms-linear-srgb'`. Provenance records source/exponent/alpha bits, actual DATA/ORIGINAL structured encoding, source alpha association, intensity metadata, profile transform/correction and first-frame behavior. The application omits the potentially large ICC byte arrays from agent state. `float-source` versus `integer-source` describes the source, independently of `outputBits:32`. Unsupported PQ/HLG transfer handling, out-of-domain sampled/LUT profile input and undefined MFT1/XYZ interpretation take explicit byte compatibility with their reason; malformed codestreams fail.

[Canonical sample definitions](../tests/fixtures/jxl-input.mjs), [21 small generated codestreams and their metadata](../tests/fixtures/jxl/metadata.json) are checked in for ordinary offline regression. The separate [validation-only encoder](../scripts/codec-color/jxl/jxl_input_fixture.cpp) regenerates them. These are original numerical fixtures, not personal photographs or external sample assets. The [maintained experiment](../scripts/experiments/jxl-input-color.mjs) compares native external FLOAT, working FLOAT and legacy byte outputs. Generated large reports stay under ignored `.workspace/jxl-input-color/`.

| Actual generated case | Native / working evidence |
| --- | --- |
| sRGB16, 512×16 | All 512 red levels survive native and working output; legacy byte output has three. Native normalized source error ≤3.73×10⁻⁹ |
| Display P3 RGB16 | Native normalized source error ≤5.97×10⁻⁸; working full red is approximately `[1.224857,-0.042031,-0.019630]`, retaining out-of-display-gamut values |
| Original linear Float32 | Native source values, including `[-0.125,0.5,1.5]`, are exact. Working output remains signed/unbounded; profile conversion changes it slightly to `[-0.125056,0.500058,1.500221]` |
| Original Display P3 Float32 | Native source values are exact; working range includes −0.06571 through 2.76917. The existing named-space signed reference differs by at most 7.69×10⁻⁴ |
| XYB Float32 | Actual lossy encode/decode retains negative values and highlights; this is measured lossy reconstruction, not a sample-exact claim |
| GRAY16 | Actual GRAY DATA ICC and its forward gamma are interpreted; coverage is separate from the color transform |

The independent [native Little CMS adapter](../scripts/experiments/jxl-input-cms.py) actually ran LCMS **2.19** against decoded DATA ICC and float samples. It used relative-colorimetric intent for matrix/gray cases, and the matching selected intent table for LUT cases; the metadata records each choice and first reference samples. Maximum linear-sRGB differences were **4.826×10⁻⁴** for Display P3 integer samples, **4.098×10⁻⁴** for signed linear samples, **7.67×10⁻⁸** for the gray ramp, and **3.24×10⁻⁴** across the corrected supported LUT fixtures. The maintained numerical budget is **5×10⁻⁴** for those CMS comparisons, with the separate signed named-space comparison budget **1×10⁻³**. These bounds reflect profile rounding, matrix conventions and the pinned implementations' arithmetic; they do not promise general CMM identity.

An initial browser assertion incorrectly demanded the linear-profile working result equal source values within 2×10⁻⁶. It failed on the values shown above. That assertion confused exact native sample decoding with the following DATA-profile transform into the destination definition. It was replaced by comparison with the actual independent LCMS reference and the measured 5×10⁻⁴ budget, rather than reporting the original identity criterion as passed.

## Reproduced pinned-CMS normalization defect

Independent LUT testing initially exposed a real error: an XYZ PCS mAB profile with B curves only yielded roughly half the LCMS output, with maximum error about 1.27. Adding an identity matrix made that simple case appear correct but did not resolve nonlinear B curves. The failing B-only fixture was retained, not replaced by the passing alternative.

The working binding now corrects the selected pinned skcms A2B XYZ normalization at its actual boundary. For mAB, it removes skcms's premature `65535/32768` factor from the parsed matrix when present, then applies the encoded-PCS factor after the B curves and final linear RGB matrix. MFT2 XYZ requires the final factor without the mAB matrix adjustment. RGB scaling commutes with the last linear matrix; alpha is not scaled. Correction is confined to these selected XYZ LUT forms and records `profileCorrection:'xyz-lut-output-scale'`; the captured legacy byte policy stays unchanged.

The maintained cases cover B-only identity and gamma, M+matrix with identity and gamma B curves, A2B1-only selection, competing A2B0/A2B1 precedence, and MFT2. All seven corrected fixtures agree with the independent selected LCMS transforms within 3.24×10⁻⁴. MFT1 with XYZ PCS has no defined eight-bit XYZ encoding in the applicable ICC contract; it takes explicit `jxl-profile-unsupported` compatibility instead of inventing normalization. This is targeted evidence, not general LUT-profile conformance.

## Genuine associated alpha and fixture limitations

The first nominal premultiplied fixture was discovered to report `sourceAlphaPremultiplied:false`: the pinned encoder did not propagate that basic-info request into its automatically created alpha channel. That was a fixture construction error, not evidence that the decoder ignored association. The validation encoder now explicitly sets/reconciles extra-channel metadata and verifies the serialized flag. The resulting actual source is associated and native FLOAT output is straight: first encoded RGB `[8192,4096,2048]` at alpha 32768 becomes `[0.25,0.125,0.0625]`; a code-one RGB/alpha pixel becomes straight RGB one with alpha `1/65535`.

Working decode converts those already-straight values once, preserving coverage. The published legacy policy returns first bytes `[127,64,32,128]` for that case, consistent with its extra premultiplication handling; those captured historical bytes remain unchanged. Functional tests distinguish this historical display behavior from correctly straight working samples rather than silently changing Original processing.

An initial narrow 4×1 floating sampled-curve fixture produced unexpected native values in the pinned validation encoder. A 32-wide equivalent decoded the intended Float32 samples exactly; the experiment records that width ablation. It is a limitation of this fixture-generation route, not evidence that arbitrary narrow JPEG XL files are corrupt or that the production decoder recovered lost source data. The out-of-domain sampled-profile compatibility case remains explicitly covered.

## Browser, GUI and native verification

Commands actually executed on Windows/Chrome:

```powershell
node --test tests/jxl-input.test.js tests/jxl-workflow.test.js
```

All **five tests passed, with no skips**, after installing the final corrected decoder and regenerating verified fixtures. The legacy regression compares every byte against the actual published WASM for **31 files**: all five named profiles at lossless/lossy quality plus all 21 committed high-depth/float/alpha/gray/orientation/animation/LUT cases. Working checks use actual codec workers, assert signed/highlight and low-bit values, preserve straight hidden RGB, verify true associated alpha, orientation 6 and the first coalesced animation frame, check the independent LUT references/correction provenance, reject corrupt inputs, recover after failure and match forced worker-startup fallback. A direct kernel test disables `createImageBitmap` to prove the successful working route does not cross the byte bridge.

The real GUI/shared dispatcher imports JXL16, opts into Linear, exposes actual provenance, renders local +4/global −4 EV, exports genuine TIFF16, returns to identical legacy pixels, exports edited state, reimports the TIFF, restores XMP/reloads and preserves original compressed bytes. Measured JXL16→TIFF16 maximum source-word error was **1**, with **8,160** red words retaining non-byte-replicated low bits and all **512** red levels. A separate GUI float fixture recovers a source highlight of 1.5 after −2 EV, and shows explicit compatibility Info text for PQ.

The root agent's Windows native smoke also exercised the actual built application/CLI with the committed fixtures: JXL16→TIFF16 had maximum code error **1**, 8,160 low red samples and byte-identical original export. The float highlight recovered to TIFF16 code **42343** against the known source reference **42341** (difference **2**), with unchanged original bytes. These are the specifically observed Windows checks; complete suite status, other-platform native runs and later acceptance belong to [acceptance](../docs/acceptance.md).

No result here establishes animation playback, arbitrary extra-channel editing, universal ICC/HDR semantics, arbitrary real-world JPEG XL files, very-large-image throughput or other native WebView behavior.
