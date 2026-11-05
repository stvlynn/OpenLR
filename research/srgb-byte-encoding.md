# Float32 to sRGB byte encoding experiment

Subsequent implementation: the chosen 20-bit candidate is now integrated into `linearFrameToRgba8` through `srgb-byte-encode.js`; scalar `encodeSrgb` and `linearFrameToEncoded` retain their existing owners and behavior. The historical prototype results below remain separate from production measurements and acceptance. New tests import the actual converter and use an independent scalar formula at all 255 byte transitions, all 256 bin centers, the transfer join, signed/HDR/subnormal values, offset/sentinel storage, reader Float32 rounding, nonfinite reader RGB and source-only alpha. Existing no-reader validation remains exercised. The actual browser encoding-worker output is compared in full before canvas scaling, with explicit successful worker results and no initial startup fallback; cancellation and deliberate startup fallback still run. The observer initially rejected a cancellation fixture's Blob URL because it assumed a URL object; handling string URLs corrected that test harness, without changing production worker behavior.

Investigated on 2026-11-06 against `9e623b5`, Windows x64, Chrome 156 and Node 24.9.0. This is a prototype experiment; no production rendering code was changed. The remaining Original dehaze latency includes encoding a full corrected source before the existing canvas geometry path, as recorded in [performance](../docs/dehaze-performance.md).

## Contract and candidate

The target is only `linearFrameToRgba8` in `web/pixel-frame.js`: Float32 linear-sRGB color becomes `255 * encodeSrgb(value)` assigned to `Uint8ClampedArray`. Alpha still comes from the original source frame, including when a pixel reader supplies reconstructed RGB. The scalar `encodeSrgb` and target-profile `linearFrameToEncoded` are separate contracts and must not be replaced by an sRGB byte lookup.

Context7 `/mdn/content` confirms [typed-array conversion](https://github.com/mdn/content/blob/main/files/en-us/web/javascript/reference/global_objects/typedarray/index.md): clamped bytes round to nearest with ties to even, whereas integer arrays normally truncate. Constructing a Uint32 view over Float32 samples must preserve the buffer, byte offset and length. The candidate uses that view to index a table by the leading bits of the IEEE-754 encoding. For each positive bucket, it evaluates both endpoint floats using the existing scalar function and clamped-byte assignment. Equal endpoint bytes give the stored byte; differing endpoints give a sentinel requiring scalar evaluation. This is a quantization shortcut, not interpolation of gamma values.

The full-preview prototype additionally handles values at or below zero (and NaN) as byte zero and values at or above one as byte 255. The no-reader path retains its existing `assertLinearFrame`, including nonfinite and alpha rejection. Reader RGB is still rounded through the same Float32 scratch buffer. Independent source review identified the scalar transfer's tiny downward jump around its rounded `.0031308` join: adjacent Float32 values `0x3b4d2e1b`/`0x3b4d2e1c` produce approximately 10.3147332/10.3147267 before byte quantization, both byte 10. Thus the relevant invariant is monotonicity of the quantized byte mapping, not strict monotonicity of every scalar intermediate.

## Isolated ablation

A 6000×4000 Float32 source uses, for pixel index `p` and channel `c`, `.04 + .9*((p*(17+c*12)) % 4096)/4095`, except every 97th pixel uses -.1 in red and 1.2 in green/blue. Alpha is `(p % 257)/256`; the synthetic transmission map is `.1+.9*(p % 1024)/1023`, with airlight (.85,.9,1). The shared dehaze reader is applied at +70 and -60, with a no-reader control. This periodic fixture is not representative of every photograph.

Three leading-bit table sizes were compared with the scalar converter. In each of three repetitions the order was forward, reversed, then forward again. Every resulting RGBA byte was compared outside the timed conversion. Tables were built separately: 16 bits took 3.1ms and 32,514 bytes; 18 bits 2.7ms and 130,050 bytes; 20 bits 9.3ms and 520,194 bytes. These are individual construction observations, not medians. All measured outputs matched the scalar reference exactly.

| Conversion | Scalar ms (three observations) | 16-bit prefix ms | 18-bit prefix ms | 20-bit prefix ms |
| --- | --- | --- | --- | --- |
| No reader | 1631.9 / 1412.2 / 1461.2 | 1526.8 / 1140.1 / 1136.6 | 1097.1 / 758.6 / 664.0 | 664.9 / 603.2 / 534.1 |
| Dehaze +70 | 1528.9 / 1683.5 / 1602.4 | 1725.7 / 1558.2 / 1466.5 | 1326.5 / 1239.2 / 1102.2 | 1190.7 / 1095.6 / 992.7 |
| Dehaze -60 | 1946.9 / 5100.3 / 4518.1 | 1579.6 / 4174.2 / 3858.8 | 1066.8 / 3360.4 / 2696.4 | 1027.9 / 1376.2 / 1801.2 |

The large late-run timing spread prevents treating these as a stable speedup distribution. The isolated converter still uses scalar evaluation for out-of-range samples, whereas the subsequent integrated prototype uses direct saturation; this ablation alone does not isolate those two contributions. No image codec, rendering geometry, worker admission or first analysis was timed here.

## Exhaustive bounded scalar check

Node enumerated every positive Float32 encoding from `0x39000000` (2^-13) through `0x3f800000` (1), inclusive: **109,051,905 values**, zero byte differences for the 20-bit candidate, with 1,044,480 sentinel fallbacks. It took about 1832.1ms on that run. Positive values below 2^-13 lie in the linear toe and produce at most `255*12.92*2^-13 ≈ .40217`, hence byte zero. This explains the unenumerated lower interval but is distinct from testing it exhaustively. Signed/HDR/reader/offset/error paths and other JS engines were not established by this scalar loop; it reconstructs the table rather than importing a production implementation.

## Initial complete-preview observation

Two fresh Chrome instances rendered the established 24MP opaque haze fixture at strengths 40, 70 and 20 to 1280×853, with source generation excluded. The second instance substituted only `pixel-frame.js` through experimental routing; no tracked source was edited. Every one of the 4,367,360 final RGBA samples per result matched. Original scalar first/cached70/cached20 took **8638.7 / 1820.4 / 1819.3ms**, with maximum 10ms-heartbeat gaps **473.5 / 100.0 / 92.1ms**. The prototype took **8815.6 / 680.8 / 670.4ms**, with gaps **696.1 / 69.7 / 68.5ms**.

Cached completion improved in this observation, but first latency and its largest main-thread gap worsened. Baseline ran first, only the candidate used routing (which disables HTTP cache), and the prototype combined saturation and table lookup. Five routed module requests do not by themselves prove worker execution. Final resized-pixel equality also does not replace pre-canvas full-source verification. A controlled follow-up therefore needs saturation-only, equal route handling, reversed order and actual worker-result evidence.

## Controlled complete-preview follow-up

The next run used fresh Chrome instances in the order **table20 → saturation-only → scalar**. All three routed `pixel-frame.js` (five requests each), equalizing that cache behavior. A Worker constructor observer recorded the encoding-worker ready message and completion payload length; each variant returned three actual **96,000,000-byte** full-source pixel payloads. This establishes worker output rather than startup fallback for these renders, but records lengths rather than comparing those full-source bytes. Each final 1280×853 image was compared byte-for-byte with the first variant and matched completely.

| Strategy | First 40 elapsed / max gap ms | Cached 70 elapsed / max gap ms | Cached 20 elapsed / max gap ms |
| --- | --- | --- | --- |
| 20-bit lookup with saturation | 7135.8 / 488.5 | 718.7 / 97.9 | 732.5 / 75.3 |
| Saturation only, scalar inside (0,1) | 8452.8 / 589.3 | 1833.9 / 83.0 | 2007.7 / 85.7 |
| Existing scalar | 11181.3 / 774.7 | 1841.1 / 90.1 | 1736.8 / 76.1 |

This controlled observation supports lookup as the main source of the cached completion improvement; saturation alone did not reproduce it. The first-operation timings vary strongly between runs, and cached maximum gaps are not consistently reduced. It does not establish cold-performance distributions, smoother frame pacing, a memory improvement or cross-platform speed. Production integration and the focused correctness checks below remain unperformed. Additional ignored evidence is `.workspace/srgb-encode-integrated-controls.json/.log`; the `--controls` mode in the integrated harness produces this comparison.

## Integration boundary

Before adoption, import the actual candidate in tests against an independent scalar oracle at every half-byte threshold and neighboring Float32 values, the transfer join and clamps, signed/HDR/nonfinite reader output, alpha ties and reader-alpha override, nonzero byte offsets, untouched source/sentinels and existing validation errors. Compare complete pre-canvas worker bytes and exercise both Original and Linear output. Each encoding worker terminates after a job, so table construction/storage is per worker realm, not a persistent image cache. Cross-platform correctness and latency require actual target engines; the Chrome probe does not supply them.

Ignored evidence: `.workspace/srgb-encode-ablation.mjs/.json/.log`, `.workspace/srgb-encode-exhaustive.mjs/.json/.log`, and `.workspace/srgb-encode-integrated.mjs/.json/.log`. The existing dehaze fixture protocol in the performance document supplies the integrated scene definition. The source/algorithm is independent OpenLR research and uses no Adobe assets or implementation.
