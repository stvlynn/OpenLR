# High precision RAW: pinned decoder evidence and executed experiment

Date: 2026-11-05. This record contains source inspection and an executed synthetic-sensor experiment. It establishes decoder capabilities and limitations, not Lightroom equivalence, a full wide-gamut editing implementation, or a new product requirement. No Adobe code, profile, photograph, or asset is used.

## Result

The shipped LibRaw WASM genuinely preserves more than 8-bit sample precision when asked for 16-bit linear output. Its `output_color=4` path also preserves some colors which `output_color=1` clips to sRGB. This is a practical next decode boundary for a float editing pipeline, but its integer demosaic/postprocessing stages already clip values. Converting the returned 16-bit integers to Float32 does not recover those lost values or create scene radiance.

There is also a separate, concrete baseline transfer error: selecting sRGB output primaries does not select the sRGB transfer curve. The baseline ordinary RAW settings at `b8b9bab` inspected for this experiment leave LibRaw's default BT.709-like transfer active, while canvas and downstream operations interpret the result as sRGB. The measured difference from explicitly encoding the same 16-bit linear sRGB samples is as much as 17 eight-bit code values on the generated ramp. This warrants correcting the display conversion independently of introducing wide-gamut editing.

## Actual API and fixed source

The tested wrapper is `@colorhythm/libraw-wasm` 1.1.1; the runtime reports `0.22.1-Release`. Its corresponding LibRaw revision is [`b860248a89d9082b8e0a1e202e516f46af9adb29`](https://github.com/LibRaw/LibRaw/tree/b860248a89d9082b8e0a1e202e516f46af9adb29). The existing provenance, license choice, build constraints, and bundled corresponding-source archives remain owned by [RAW decoding](../docs/raw-decoding.md). No new dependency or signature/hash gate is introduced.

Context7 `/libraw/libraw` was used for API discovery. Conclusions about the shipped binary use the pinned sources, also extracted from the repository's existing `web/vendor/libraw/source/LibRaw.tar.gz` into ignored `.workspace/raw-precision/source/`.

| Evidence | Observed behavior |
| --- | --- |
| [`doc/API-datastruct.html`](https://github.com/LibRaw/LibRaw/blob/b860248a89d9082b8e0a1e202e516f46af9adb29/doc/API-datastruct.html) | `output_color` selects output primaries/matrix; `output_bps` selects 8/16-bit. Gamma is separate: the documented default is BT.709, sRGB requires inverse exponent `1/2.4` and toe slope `12.92`, linear requires `1,1`. ICC filename options require LCMS support, absent from the bundled build. |
| [`src/utils/init_close_utils.cpp`](https://github.com/LibRaw/LibRaw/blob/b860248a89d9082b8e0a1e202e516f46af9adb29/src/utils/init_close_utils.cpp) | Actual constructor defaults include gamma `.45,4.5`, `output_color=1`, 8-bit output, and automatic scale enabled. Disabling auto brightness alone does not establish an absolute radiometric scale. |
| [`src/postprocessing/postprocessing_utils_dcrdefs.cpp`](https://github.com/LibRaw/LibRaw/blob/b860248a89d9082b8e0a1e202e516f46af9adb29/src/postprocessing/postprocessing_utils_dcrdefs.cpp) | Color 4 uses the fixed matrix named `ProPhoto D65`. It composes this with the camera-to-sRGB matrix before converting pixels. The generated profile's PCS colorants are derived from the inverse output matrix and the library's D50-adapted sRGB colorants. |
| [`src/postprocessing/postprocessing_utils.cpp`](https://github.com/LibRaw/LibRaw/blob/b860248a89d9082b8e0a1e202e516f46af9adb29/src/postprocessing/postprocessing_utils.cpp) | Matrix results are cast to integers and clipped into unsigned 16-bit channels. Negative color components and values above the representable interval are lost before the memory image is returned. Other processing stages also use integer buffers. |
| [`src/postprocessing/mem_image.cpp`](https://github.com/LibRaw/LibRaw/blob/b860248a89d9082b8e0a1e202e516f46af9adb29/src/postprocessing/mem_image.cpp), [`src/utils/curves.cpp`](https://github.com/LibRaw/LibRaw/blob/b860248a89d9082b8e0a1e202e516f46af9adb29/src/utils/curves.cpp) | Memory image generation applies the selected lookup curve. Eight-bit output discards its low eight bits. Linear gamma, no auto brightness, and brightness one make the 16-bit output curve an identity. |

The shipped JS methods `setOutputColor`, `setOutputBps`, `setGamma`, `setUseCameraWb`, `setNoAutoBright`, and `setBright` already expose all settings used here. `dcrawMakeMemImage()` returns copied owned bytes and clears its C allocation; `dispose()` releases the decoder. Its returned structure contains dimensions, channel count, bit depth, layout type, and bytes, **no ICC/profile field**. An application must attach its own explicit color contract rather than infer one from the type array.

### Meaning of the wide matrix

The pinned numerical transform is `wideLinear = W × linearSrgb`:

```text
W = [ 0.529317  0.330092  0.140588
      0.098368  0.873465  0.028169
      0.016879  0.117663  0.865457 ]
```

The inverse reconstructs unbounded linear sRGB from values that survived wide-space clipping. The matrix can be described without ambiguous profile naming: its exact library-compatible D50 PCS transform is `LibRaw.xyzd50_srgb × inverse(W)`. The experiment records both matrices in its JSON result.

Do not conclude from the source's `D65` label alone that these values are incompatible with ordinary Bradford-adapted ProPhoto D50. The measured difference between the library-derived PCS colorants and OpenLR's existing independently generated standard ProPhoto profile is only `0.000116259` at most. The eight patch centers interpreted through these two definitions differ by at most `0.000115431` in reconstructed linear sRGB. These are small finite-precision/definition differences, not evidence of a large whitepoint error. Still, exact numerical and transfer contracts should be explicit: an ordinary ProPhoto profile with gamma 1.8 is not a matching profile for linear wide-space values. Either transform to the chosen standard definition, or construct a matching linear profile from the exact declared matrix.

## Executed experiment

Run:

```sh
node scripts/experiments/raw-precision.mjs
```

The script uses the repository's existing Playwright/Chrome and fixture server conventions, calls the **actual vendored WASM**, and writes JSON to ignored `.workspace/raw-precision/results.json`. Its three modes explicitly reconstruct the inspected baseline settings; consequently the experiment remains reproducible after the production kernel changes. It does not import a mocked decoder, use a JPEG preview, or generate results by expanding 8-bit values.

Two original uncompressed 12-bit RGGB DNGs are generated using the existing project fixture writer. The experiment replaces only the sensor strip with a 4096×64 ramp or eight 64-pixel-wide patches in a 512×64 image. Both use the fixture's identity ColorMatrix, black 256, white 4095, camera white balance, and no embedded preview. The ramp has 2048 two-column sensor steps; border sampling excludes eight pixels. These unusual synthetic camera matrices provide mathematical stress cases, not a calibrated physical camera model. Fixture bytes are compared directly before/after; no file hash is used as an acceptance gate.

All three modes use full-size decode, camera WB, no automatic brightness, brightness one:

| Mode | Output color | Bits | Gamma |
| --- | --- | --- | --- |
| Existing ordinary baseline | 1 | 8 | untouched library default `.45,4.5` |
| Existing linear baseline | 1 | 16 | `1,1` |
| Wide candidate | 4 | 16 | `1,1` |

Executed successfully on Windows, Node `v24.9.0`, Chrome `155.0.8059.39`, LibRaw `0.22.1-Release`. The first sandboxed run failed with localhost `net::ERR_NETWORK_ACCESS_DENIED`; rerunning with approved local-browser access completed. The latest completed run includes all measurements below.

| Ramp observation, central row | 8-bit default gamma | 16-bit linear sRGB | 16-bit linear wide |
| --- | ---: | ---: | ---: |
| Distinct values per channel | 227 | 2040 | 2040 |
| Channel samples not divisible by 257 | N/A | 12184 | 12190 |
| Nonclipped reconstructed sRGB agreement against linear-sRGB decode | N/A | reference | max `1.71459` 16-bit levels |

The first and third rows establish real extra precision; a 16-bit container holding `8bit × 257` cannot produce the measured nonmultiple samples. The synthetic 12-bit input does not establish 16 effective sensor bits.

For the same 12240 central ramp channel samples, explicit standard sRGB encoding of linear-sRGB decode differs from the default-gamma 8-bit decode in 11508 samples. Maximum absolute difference is **17** code values; mean absolute difference **7.517973856**; mean explicit-minus-default **7.500326797**. Explicit sRGB produces 210 distinct values per channel in this interval. Different transfer curves allocate codes differently, so 227 versus 210 is not a quality ranking. This comparison includes expected final quantization differences, but those cannot account for the 17-code maximum. It measures a materially different base rendering, not merely a metadata label.

The patch image has 23808 interior pixels. Of these, **6144** have every wide-space channel strictly inside its representable interval, yet reconstruct outside sRGB by more than four 16-bit levels. This is the meaningful retained-gamut observation: these pixels survived the wider decoder boundary, whereas sRGB cannot represent their coordinates. Across all interior pixels, 14880 reconstructed triplets are outside sRGB, but this larger count also includes wide-clipped pixels and must not be claimed as fully preserved source colors. There are 17568 sRGB-decode boundary pixels; boundary counts alone do not prove clipping, because legitimate black/white can occupy them.

Two actual patch centers illustrate the retained information:

| Sensor patch | Linear sRGB 16-bit codes | Wide 16-bit codes | Wide reconstructed linear sRGB |
| --- | --- | --- | --- |
| `[.15,.5,.12]` | `[0,58651,3213]` | `[5479,48656,9224]` | `[-.413177733,.894947952,.049015704]` |
| `[.15,.25,.6]` | `[0,26072,47147]` | `[5678,22325,43567]` | `[-.275491814,.397831409,.719423144]` |

Their wide channels have no zero/65535 sample, so the negative reconstructed red is not an artifact of wide clipping. Other patches do hit wide boundaries; no exact original color reconstruction is claimed there. For 6240 patch pixels where both decodes are interior and reconstructed sRGB is representable, maximum disagreement is `1.63239` 16-bit levels. All returned dimensions and channel counts match the generated fixtures; fixture bytes remain unchanged.

Single-run decoder timing is included in the raw result for diagnostics, but is not a performance benchmark. This experiment bypasses the application Worker/selection path, GUI, export encoding, and monitor transform. Existing lifecycle tests remain responsible for disposal, orientation, stale-result prevention, and import failures. No physical camera validation or cross-WebView validation is established here.

## Next integration contract (proposal)

First repair ordinary RAW display semantics by decoding 16-bit linear sRGB and explicitly applying the standard sRGB transfer when making its display bitmap. This can share the existing linear sample conversion while retaining DNG/HDR's documented sRGB primaries. It changes the ordinary RAW base appearance, so the same change must update RAW documentation and verify actual pixels against the linear source. It does not constitute wide-gamut editing.

For a later high-precision editor, introduce a versioned RGB frame carrying dimensions, RGB interleaved Float32 samples, opaque/unassociated alpha semantics, a **linear** transfer declaration, exact matrix/whitepoint identity, decoded sample bounds/precision, source asset identity, and edit revision. A decoder-specific ID such as `libraw-prophoto-linear-v1` plus the numerical PCS matrix avoids conflating this boundary with an arbitrary ICC file. Float operations must preserve signed/out-of-range intermediate values; display and export adapters own the final gamut treatment and quantization. A standard working space is also viable if an explicit unbounded matrix conversion is performed at ingestion.

Do not silently replace `decodePhotoLinear()`'s sRGB values with wide values: the existing DNG writer emits an sRGB calibration matrix and HDR consumers assume the old space. Add an explicit wide-frame boundary or convert at each legacy consumer. Existing 8-bit recipes also need defined version/interpretation semantics before switching their editing space; HSL, masks, optics, heal sampling, resampling, enhancement, and export must consume the same declared contract.

The practical wide decoder still has normalized integer clipping and camera-processing choices. Truly unclipped scene-linear demosaic requires a different exposed processing boundary or rebuilt decoder, not merely changing an array type. Original sensor bytes remain the authoritative recoverable source. Full wide-gamut editing, high-bit-depth file exports, camera calibration accuracy, monitor profiles, HDR display, and Adobe/Lightroom rendering equivalence each need their own actual evidence.

## Subsequent correction

The production kernel now explicitly requests the same 16-bit linear sRGB decode for ordinary and linear-frame use, applying the shared standard sRGB transfer to display samples. The experiment above deliberately reconstructs the old settings directly through LibRaw so the negative control remains reproducible. Ordinary editing still consumes an 8-bit display bitmap; this fix is not full high-precision editing. See [processing measurements](pipeline-precision.md) and [RAW product contract](../docs/raw-decoding.md).
