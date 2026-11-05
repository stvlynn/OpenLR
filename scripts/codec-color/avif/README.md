# AVIF color binding build

This rebuilds the pinned jSquash AVIF C++ bindings against the same libavif,
libaom and SharpYUV source revisions used by the packaged baseline. It does not
patch an encoded AVIF container. All color fields are present when libavif
converts the input RGB samples and when libaom writes the AV1 bitstream.

Prerequisites: Emscripten **3.1.64**, Node 24, CMake 3.20 or later, Ninja, Python 3,
Perl, and tar. On Windows, run the build in WSL after downloading sources from
the workspace's Windows Node if Linux networking is unavailable:

```sh
node scripts/codec-color/avif/fetch-sources.mjs
source scripts/codec-color/environment.sh
bash scripts/codec-color/avif/build.sh
node scripts/codec-color/avif/smoke.mjs
node scripts/codec-color/avif/smoke-threaded.mjs
PYTHONPATH=.tools/color-cms python scripts/codec-color/avif/check-cms.py
```

`OPENLR_AVIF_BUILD_DIR` changes the source/build/output directory;
`OPENLR_BUILD_JOBS` defaults to 2. The build emits single-thread encoder and
decoder plus a pthread encoder under `.tools/codec-color/avif/output`. Source
downloads and SDK installation are separate from compilation; the normal
application does not download or compile a codec.

The encoder retains jSquash's existing quality/bit-depth/subsampling fields and
adds required `icc` (Uint8Array), `colorPrimaries`, `transferCharacteristics`,
`matrixCoefficients` (-1 for upstream automatic choice), and `fullRange` fields.
The caller converts sRGB editing samples to the target RGB space before this
encoder call. An ICC profile describes those native samples. CP/TC may be 2
(unspecified) when ICC defines the exact space, avoiding conflicting or merely
approximate CICP declarations. MC remains operational: identity 0 plus full
range and 4:4:4 for exact lossless RGB, BT.601 6 for upstream lossy YUV. Decoder
RGB is always full range regardless of encoded YUV range.

`decodeWithColor(bytes, 8)` returns copied native RGBA, ICC, CP/TC/MC, range and
source/output depth. It performs YUV-to-RGB but no gamut or transfer conversion.
Use the ICC through the application's tagged-PNG CMS bridge before display.
The caller must handle non-ICC CICP explicitly. Legacy `decode` remains available
for ABI compatibility; it must not be interpreted as color-managed sRGB for
arbitrary input. Conversion failures return null to the JS adapter, which owns
the visible error message.

`sources.json` records immutable commits and applicable licenses. The adapted
bindings and `pre.js` retain jSquash's Apache-2.0 license in `LICENSE.jsquash`.
Runtime distribution must also retain the existing codec notices for libavif,
libaom, SharpYUV/libwebp and Emscripten. OpenLR's project license does not replace
those terms. The CMake integration and scripts are OpenLR source.
