# Dehaze performance and image acceptance

The subsequent [sRGB byte-encoding experiment](../research/srgb-byte-encoding.md) investigates the remaining Original source-sized conversion. A routed 20-bit bucket prototype matched tested output bytes and reduced cached 24MP completion to about .72–.73s versus 1.74–1.84s for the scalar control in one controlled run. Saturation alone did not reproduce the gain. First latency and main-thread gaps remain variable. This is research only: no production converter has been replaced and no new platform acceptance is claimed.

Measured on 2026-11-05, Windows x64, AMD Ryzen 7 7840U (16 logical processors), 30.84 GB installed RAM, Node v24.9.0 and headless Chrome 156.0.8078.80. This is a bounded local measurement, not a cross-platform performance guarantee. [Dehaze](dehaze.md) owns the behavior; [research](../research/dehaze.md) owns the algorithm and prior limitations.

## Large-image measurement

The generated source is 6000 × 4000 (24 MP), straight-alpha linear sRGB, with atmospheric light A=(.85,.9,1), a .35/.8 transmission discontinuity at the middle column, a smooth colored scene and dark anchors every 17 rows/columns. The top 32 rows equal A. For channel c, non-anchor scene intensity is `.05+.65*((x/width+y/height+c*.2)%1)`; input is `scene*t+A*(1-t)`. All alpha is 1. The Original experiment encodes this scene to an 8-bit canvas and creates an ImageBitmap; the Linear experiment uses a Float32 frame directly. Therefore these timings compare each actual adapter, not identical source precision.

Timing starts after source generation. The render target is 1280 × 853. First strength is 40, followed by 70 and 20 against the same immutable source, so the latter operations reuse the atmospheric estimate. Values below are individual runs, not medians or a latency distribution. Build/native acceptance was held during the final measurements; normal unrelated system activity was not controlled.

| Executed operation                                                                         | First analysis/render | Cached strength 70 | Cached strength 20 | Process peak memory                                                  |
| ------------------------------------------------------------------------------------------ | --------------------: | -----------------: | -----------------: | -------------------------------------------------------------------- |
| Linear `renderFrame`, initial separate-box-pass/materialized-reconstruction implementation |              22.120 s |            1.134 s |            1.138 s | Node peak RSS 1.977 GB                                               |
| Linear `renderFrame`, fused streaming moments and reconstruction during geometry           |               7.016 s |             .403 s |             .398 s | Node peak RSS 1.075 GB                                               |
| Original Chrome `render(ImageBitmap, edit, 1280)`, optimized implementation                |               9.762 s |            2.096 s |            2.111 s | Active renderer peak working set 1.280 GB; GPU process peak 1.205 GB |

The independent optimized domain measurement completed source-resolution `analyzeDehaze` in 5.365 s. At the end of that stage its process high-water RSS was 687.6 MB, including the 384 MB source frame; the retained Float32 transmission map is 96 MB. A separate cached full-source copy plus `dehazeFrame` took .688/.612 s. These domain numbers do not include image decode, source corrections, geometry, canvas conversion, thumbnails or persistence.

Node memory uses `process.memoryUsage()` and the OS high-water `process.resourceUsage().maxRSS`; the render-only harness does not retain a separate domain analysis. It calls explicit GC between render measurements, but these counters still include temporary and cached allocations and do not establish a steady-state bound. Original uses Windows process `WorkingSet64`/`PeakWorkingSet64` for processes returned by Chrome's `SystemInfo.getProcessInfo`. Its memory includes the generated ImageData/canvas/ImageBitmap and browser surfaces. Separate process peaks are not simultaneous and must not be added as a measured total. Original source generation took 2.817 s and is excluded from the rendering table. No arbitrary image-size rejection was added.

Exact streaming weighted moments and fused reconstruction reduce measured work and memory substantially without reducing analysis resolution. They do **not** complete responsive large-image interaction: first analysis still synchronously blocks for several seconds, Linear cached updates are around 400 ms here, and Original cached updates still take about two seconds because they traverse and encode the source-sized image before its existing geometry path. These results do not support a 60-fps slider claim. Background analysis with source/revision ownership, and an independently validated Original preview optimization, remain future work; an RGB-downsampled analysis proxy was separately rejected because it lost dark anchors.

Local ignored harnesses and evidence are `.workspace/dehaze-performance-streaming.mjs`, `.workspace/dehaze-render-performance.mjs`, `.workspace/dehaze-original-performance.mjs` and their JSON outputs. The initial render evidence is preserved as `.workspace/dehaze-render-performance-baseline.json`. These local measurement artifacts are not distributed test commands. The tracked domain/workflow tests provide repeatable correctness checks; the exact fixture and measurement protocol above describe this performance observation.

## Actual exported images and controls

The real Chrome dispatcher imported and exported PNG for the public-domain NASA astronaut fixture (provenance in [fixture README](../tests/fixtures/ai/README.md)) and two generated 512 × 256 scenes. Both Original and Linear processing were exercised at 0, +50, +100 and -60, then reset to zero. All six fixture/version reset exports matched their initial decoded pixels exactly. The existing Effects slider accepted an ArrowRight keyboard step and committed `Dehaze: 1`. At a 1024 × 768 viewport, the Effects panel measured 237 pixels for both client width and scroll width, with no horizontal overflow; the actual screenshot was inspected.

The hazy fixture has A=(.85,.9,1), transmission .35/.8, anchors every third row/column and a top 16-row airlight strip. Its non-anchor scene is `.05+.55*((x/512+y/256+c*.2)%1)`. Positive strength visibly reduces the veil; -60 adds a strong uniform veil. On the astronaut, +50 moderately increases contrast; +100 darkens the background, makes the colored shoulder/background contour more pronounced and clips additional shadows. Counting RGB channels equal to zero in the 512 × 512 PNG gives 86,818 at neutral and 93,211/93,195 at +100 for Original/Linear. This is evidence of the bounded display output, not a claim that the float domain clips or that the effect improves every photo.

The intentionally prior-violating clear fixture is a neutral linear .7-to-.9 horizontal ramp beneath a .95 top strip, encoded to 8-bit sRGB. At +100 it is visibly over-darkened and banded in both processing versions: center RGB changes from (231,231,231) to (124,124,124), minimum from 218 to 94, and the maximum adjacent channel step on the center row rises from 1 to 14 code values. At +50 the center is 218 and maximum step 2. This preserves the negative result: a dark-channel prior cannot reliably distinguish bright clear surfaces from haze, and strong reconstruction amplifies quantized input steps. Do not call the operation automatic haze detection, halo-free, or universally beneficial.

The optimized implementation repeated the complete exported-image run. Compared with the pre-optimization 1536 × 858 contact sheets, the maximum decoded channel difference is 1/255, affecting six channels in Original and five in Linear; inspected appearance and the reported pixel probes remain unchanged. This contact-sheet comparison includes display resampling and is not an exhaustive per-pixel proof for all original-size outputs. Independent domain and fused-render oracle tests own numerical correctness.

Ignored image evidence is `.workspace/dehaze-visual-v1.png`, `.workspace/dehaze-visual-v2.png`, `.workspace/dehaze-controls-1024.png`, `.workspace/dehaze-visual-metrics.json` and `.workspace/dehaze-visual-comparison.json`; `.workspace/dehaze-visual.mjs` drives the actual dispatcher and export path using resolved asynchronous state waits. None of these measurements establishes native WebView performance or macOS behavior. Native results belong in [acceptance](acceptance.md).


## Integrated background analysis measurement

After production caller integration, the same 6000×4000 generated fixture was measured separately in Chrome 156 on the same Windows/Ryzen machine before builds/native tests were started. `renderPrepared` rendered edge 1280 at strengths 40, 70 and 20. A 10ms interval measured heartbeat ticks and maximum gaps including preparation and final synchronous rendering. Source generation was excluded. Linear used the generated Float32 source bound to a display surface; Original used the encoded ImageBitmap as before. These are single runs, not a latency distribution.

| Path | First render | Heartbeat ticks / maximum gap | Cached 70 / 20 | Maximum cached gap |
| --- | ---: | --- | --- | --- |
| Original | 9.079s | 569 / 1.795s | 1.780s / 1.659s | 1.780s / 1.659s |
| Linear | 6.061s | 533 / .413s | .302s / .293s | .302s / .293s |

The analyzer no longer blocks the main thread continuously: the heartbeat runs during worker computation. Cached reconstruction still runs synchronously and has zero heartbeat ticks within those particular short operations. Original remains visibly blocking for around 1.7–1.8 seconds, while Linear has roughly 300ms synchronous updates. Background analysis is implemented; responsive whole-pipeline interaction is not yet established. Source correction/conversion and final reconstruction/encoding remain the next optimization targets without reducing analysis resolution or changing the exact image rule.

Observed active-renderer peak working sets were 1.195GB Original and 1.341GB Linear; GPU process peaks were 1.205GB and .506GB respectively. They include generated canvases, source arrays, browser surfaces and caches, and are not simultaneous totals. The Linear browser fixture retains both generated float samples and its display canvas, so these values cannot be compared directly to the earlier Node-only RSS as an allocation regression. Ignored scripts/JSON are `.workspace/dehaze-background-performance-v1.*` and `-v2.*`. These browser measurements do not establish native WebView latency.

## Reconstruction transport experiment

Measured separately against `a632bc4` on the same Windows/Chrome 156 environment. The 6000×4000 linear fixture above was prepared once at strength 40, then full-source `linearFrameToRgba8` with the shared dehaze mapper ran at strength 70. The experiment excludes first analysis, canvas upload, geometry, later edits and decode. Each strategy ran once in the listed order; values are not medians. A 10ms heartbeat includes explicit copying and worker startup/transport. Full byte comparison against a fresh synchronous oracle occurs outside each timing.

| Strategy | Total conversion | Kernel | Explicit copy | Heartbeat ticks | Maximum gap | Differing output bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Main thread | 1451.0ms | 1451.0ms | — | 0 | 1451.7ms | 0 |
| Worker with structured-cloned message | 1836.7ms | 1466.8ms | implicit | 154 | 305.8ms | 0 |
| Worker with owned copy/transfer | 1567.0ms | 1490.9ms | 51.2ms | 152 | 52.5ms | 0 |

All strategies retained the original 384,000,000-byte frame, published corrected frame of the same size, and 96,000,000-byte transmission map attached. Copy/transfer additionally allocates 480,000,000 input bytes and the converter creates 96,000,000 output bytes; these are array sizes, **not measured process peak memory**. The converter returns its output buffer by transfer. No OffscreenCanvas assumption is involved. This supports a responsiveness improvement hypothesis while exposing its allocation cost; it does not establish whole-preview latency, repeated-drag memory behavior or native support. [Research](../research/dehaze-background.md) records the pending scheduler requirement. Production still uses synchronous reconstruction.

The executed ignored harness/result are `.workspace/dehaze-encoding-ablation.mjs` and `.json`. Its initial syntax error was corrected before execution; the sandboxed browser then could not reach localhost. The completed run used the authorized local-server permission and exited zero. No application code changed for this experiment.

## Integrated Original encoding worker

The production integration was measured with the same 24MP Original fixture and 1280×853 `renderPrepared` protocol, separately before builds/native suites. The existing scheduler allocates owned source/map copies only after admission. The worker imports the existing mapper and converter; main-thread canvas upload and geometry retain their existing behavior. Single runs in Chrome 156 on the Windows/Ryzen machine:

| Stage | Total preview | 10ms heartbeat ticks | Maximum gap |
| --- | ---: | ---: | ---: |
| First strength 40 | 8.829s | 698 | 1.717s |
| Cached strength 70 | 1.683s | 156 | .081s |
| Cached strength 20 | 1.696s | 157 | .085s |

The cached main-thread gap improves substantially versus the earlier 1.780/1.659s blocking measurements; total preview completion remains about 1.7s. The first source correction/byte-to-linear conversion still blocks for about 1.7s, so this does not establish continuously smooth interaction. Source generation took 2.234s and was excluded. Center output probes matched the previous integrated run at all three strengths; complete numerical equivalence is covered separately by small-image full-byte tests, not inferred from those probes.

Active renderer peak working set was 1.572GB, compared with 1.195GB in the earlier analysis-only run; GPU process peak was 1.206GB. These include generated surfaces and caches, are single observations rather than a memory bound, and separate process peaks must not be summed. The higher allocation cost is retained as a tradeoff, not hidden by reducing source resolution. Ignored harness/result: `.workspace/dehaze-encoding-integrated-v1.mjs` and `.json`. Native acceptance and repeated-drag ownership checks remain separate evidence.

## Exact byte-transfer lookup

The remaining source conversion called the continuous sRGB transfer function once per RGB sample, despite RGBA8 having only 256 possible channel values. Existing byte render, local-adjustment and optics paths already used independently constructed 256-entry tables. The implementation now shares one Float64 table owned by `color-spaces.js`, generated from the existing `decodeSrgb`; byte-to-Float32 conversion and byte output-space conversion reuse it. There is no approximation, source downsampling or new transfer formula. Higher-depth and signed/HDR continuous inputs retain their continuous paths; Float32 rounding still occurs at frame assignment.

An isolated Chrome 156 ablation on the same Windows/Ryzen machine used 6000×4000 RGBA bytes, with byte `i` initialized to `(i*17+floor(i/4))%256`, including varying alpha. Both variants consumed the same canvas readback (which may premultiply-round colors); readback took 19.8ms. Every resulting sample was checked outside timing against the scalar formula and Float32 assignment, including alpha. All comparisons were exact.

| Conversion in execution order | Time | Differing samples |
| --- | ---: | ---: |
| Scalar transfer, run 1 | 1338.7ms | 0 |
| Float64 lookup, run 1 | 203.9ms | 0 |
| Scalar transfer, run 2 | 1503.7ms | 0 |
| Float64 lookup, run 2 | 206.8ms | 0 |

Each output remains 384,000,000 bytes; the shared table is 2048 bytes. This measures conversion only, not source corrections or rendering, and two observations are not a latency distribution. The retained experiment is `.workspace/byte-linear-ablation.mjs`/`.json`. The tracked `srgb-byte.test.js` exhaustively verifies all byte codes, independent scalar values, alpha, typed-array slices, input preservation and invalid frame boundaries.

The complete Original dehaze fixture/protocol above was then rerun before builds/native testing. First preview took 8.830s with 807 heartbeat ticks and a .657s maximum gap; cached strengths took 2.156/1.999s with 203/186 ticks and .095/.087s gaps. Center output probes matched the earlier run. Compared with the earlier 8.829s first preview and 1.717s maximum gap, first main-thread blocking improved but total latency did not; cached completion was slower in this single run. These observations do not support an overall throughput improvement or smooth-interaction claim. Renderer/GPU peak working sets were 1.569GB/1.312GB, respectively, not a simultaneous total. Source generation was 2.260s, excluded. Evidence is `.workspace/dehaze-byte-lut-integrated.mjs`/`.json`. Further work must distinguish remaining source corrections, allocation and scheduling from the now-cheaper transfer function.

## Byte conversion inside the analysis worker

The subsequent integration transfers corrected Original RGBA8 bytes to the existing analysis worker, which calls the same exact converter before analysis. The main thread no longer allocates/converts that Float32 source. At 24MP, the queued owned input is 96MB instead of 384MB; this is a typed-array size comparison, not a claim that overall process memory falls by 288MB. During conversion the worker may retain both buffers; the published source remains Float32. The original decoded image is never transferred.

Using the same Original fixture/protocol on Chrome 156 before concurrent builds/tests, first preview took **8.059s**, with 750 heartbeat ticks and a **.428s** maximum gap. Cached strengths took **1.639/1.744s**, with 151/163 ticks and **.089/.074s** maximum gaps. All three center probes matched the preceding measurements. Renderer/GPU peak working sets were **1.571GB/1.297GB**, not simultaneous totals. Generation took 2.260s and was excluded. Ignored harness/result: `.workspace/dehaze-byte-worker-integrated.mjs`/`.json`.

The measured first blocking interval improves versus the prior .657s lookup-only and 1.717s pre-lookup paths. These single observations do not establish a throughput distribution or a memory regression/improvement; remaining .428s blocking and multi-second completion still preclude a general smooth-drag claim. Source corrections/readback and final canvas/later stages remain synchronous. Small-image full sample/map comparisons, cancellation/selection tests and native runs establish correctness separately from this performance probe.

## Source readback alternatives (2026-11-06)

A subsequent isolated experiment on the same Windows/Node 24.9/Chrome 156/Ryzen 7840U machine compared HTML Canvas readback with OffscreenCanvas on the main thread and in a worker. This measures source acquisition only, not dehaze analysis or a complete preview. The generated 6000×4000 fixture assigns pixel index `p` the RGBA bytes `(p % 256, 17*p % 256, 37*p % 256, floor(p/256) % 256)`, uploads via `putImageData`, then creates one immutable ImageBitmap. Every candidate draws the complete bitmap at native dimensions into a fresh 2D canvas with `willReadFrequently:true`, reads all pixels, and compares every returned byte with the baseline. The alpha pattern deliberately tests premultiplied-alpha round trips. Image generation and byte comparison are outside measured intervals. The original bitmap retained width 6000 throughout.

| Candidate, three sequential observations | Total elapsed ms | Maximum 10ms-heartbeat gap ms | Byte differences against HTML Canvas |
| --- | --- | --- | --- |
| HTML Canvas, direct original | 407.4 / 134.4 / 159.7 | 407.4 / 134.4 / 159.7 | 0 |
| HTML Canvas, explicit bitmap copy | 136.7 / 115.8 / 113.5 | 136.7 / 115.8 / 113.5 | 0 |
| OffscreenCanvas, main thread | 122.5 / 119.7 / 108.3 | 122.5 / 119.7 / 108.3 | 721,080 channels, maximum 1/255 |
| OffscreenCanvas worker, explicit owned bitmap transfer | 257.7 / 291.5 / 312.3 | 17.3 / 33.0 / 32.8 | Same 721,080 channels, maximum 1/255 |
| OffscreenCanvas worker, structured clone of original | 204.1 / 254.2 / 255.4 | 75.7 / 96.0 / 96.2 | Same 721,080 channels, maximum 1/255 |

Worker elapsed time includes startup and input handoff. All candidates were run in the listed order in each repetition, so later cases benefit from source/cache warm-up; this table is not an unbiased throughput ranking. The independent main-thread OffscreenCanvas case reproduces the same differences, while the explicit ImageBitmap copy on HTML Canvas does not. That isolates the observed pixel discrepancy to the canvas readback path rather than copying alone. It does not identify the browser's internal rounding mechanism, prove another engine behaves identically or establish the final dehaze error. The worker alternative is not adopted as an exact substitute without resolving this boundary. Its graphics resources were closed and workers terminated after use.

A second experiment kept HTML Canvas and copied successive 64-, 256- or 1024-row `getImageData` strips into one complete RGBA8 frame, yielding through MessageChannel between strips. Every byte matched. In the baseline-first order, 256-row reads took 173.3 / 160.4 / 157.6ms with gaps 79.2 / 79.8 / 76.0ms; 64-row reads took 278.0 / 244.2 / 216.6ms and 1024-row reads 157.5 / 137.7 / 149.4ms. The smaller strips did not provide a consistent responsiveness win, and all require extra allocations/copies and asynchronous capture ownership.

Reversing the order exposed the cold-start limitation: the first 256-row run took **424.9ms with a 307.0ms maximum gap**, followed by 173.3/213.9ms warm runs. Thus the attractive ~76ms warmed result does not remove the first readback stall. No strip implementation was added to production. This leaves source readback responsiveness unresolved; it does not justify reducing analysis resolution or silently changing pixels. Existing Linear reconstruction and final canvas/later stages remain separate targets.

Ignored evidence: `.workspace/dehaze-readback-ablation-first.mjs`/`.json`, `.workspace/dehaze-readback-ablation.json`, `.workspace/dehaze-readback-tiles.mjs`/`.json` and `.workspace/dehaze-readback-tiles-first.json`. These are performance observations, not browser/native acceptance runs or new pass counts. No production behavior changed in this investigation.

## Linear reconstruction worker (2026-11-06)

An isolated transport ablation used the same 24MP floating haze fixture, already prepared source/map, strength 70, Exposure .2, crop (.1,.1,.8,.8), one quarter-turn and a 1280px output edge. The existing `renderFrame` computed every candidate; float output samples matched exactly. Synchronous execution took 401.0ms with a 402.0ms maximum 10ms-heartbeat gap. Structured cloning took 748.1ms with a 205.4ms gap; explicit copies/transfers took 567.5ms with a 66.9ms gap, including 65.4ms copying. This supports the owned-copy option for responsiveness, not a kernel speedup. Each observation ran once; startup, copy and worker kernel time were included, while first analysis and terminal display encoding were excluded. The 384MB corrected source and 96MB transmission map remained attached; an admitted worker needs additional owned copies of both. Evidence: `.workspace/dehaze-linear-ablation.mjs`/`.json`.

Production integration extracts the unchanged corrected-frame geometry and subsequent float operations into `frame-render.js`. Both synchronous rendering and `dehaze-frame-worker.js` call it. The existing queue allocates source/map copies only at admission, using the same snapshot adapter as Original encoding; it does not keep one copy per queued request. Display encoding remains outside this worker and float export retains the returned samples.

The complete 24MP Linear preview was then measured in separate fresh Chrome instances against the `4720ad0` renderer and the integrated renderer, on the same machine as above. This fixture uses the established 1280×853 full-view output with strengths 40, 70 and 20 and no additional adjustments. Generation/display-surface setup was excluded (2.146/2.160s). All three center probes matched; the separate small-image tests compare complete float and display outputs.

| Stage | Baseline elapsed / maximum gap | Worker elapsed / maximum gap | Worker heartbeat ticks |
| --- | --- | --- | --- |
| First analysis + preview, 40 | 6.792s / .454s | 6.867s / .467s | 627 |
| Cached strength 70 | .344s / .344s | .314s / .093s | 18 |
| Cached strength 20 | .353s / .353s | .319s / .099s | 18 |

Baseline cached runs had zero heartbeat ticks. Cached responsiveness improved in this observation, while the first gap and first completion did not improve. Peak active renderer working set increased from **1.243GB to 1.591GB**; GPU peaks were .422GB in both runs. Per-process peaks are not a simultaneous total and include fixture/surface/cache storage. These single runs do not establish a general throughput improvement or smooth 60fps interaction. First source preparation, owned copies and terminal display encoding remain costs to address. Evidence: `.workspace/dehaze-linear-integrated.mjs`/`.json`; native correctness results belong in acceptance rather than being inferred from these Chrome timings.
