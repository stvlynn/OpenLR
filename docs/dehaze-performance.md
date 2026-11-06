# Dehaze performance and image acceptance

The subsequent [sRGB byte-encoding experiment](../research/srgb-byte-encoding.md) investigated the remaining Original source-sized conversion. Its routed 20-bit bucket prototype matched tested output bytes; saturation alone did not reproduce the cached gain. The production integration and its separate measurements are recorded here. First latency and main-thread gaps remain variable; platform acceptance is recorded separately.

## Trusted 24 MP Windows slider measurement (2026-11-06)

A fresh unpacked Windows/amd64 build of `07ce383` ran on Windows 11 build 26200, WebView2 156.0.4314.58, Ryzen 7 7840U and 30.84 GB RAM. The runner used Node 24.9.0 and two isolated host profiles, one per processing version. Both imported the same 6000×4000 opaque sRGB PNG generated from the haze formula below. The viewport was 1426×923 CSS pixels at device pixel ratio 1.25, and the Detail stage published a 1181×787 canvas. Fixture generation, import, neutral capture and PNG verification were outside draft timing.

Playwright sent pointer input through the private WebView2 connection and recorded trusted pointer, input and change events. Each cold gesture held the first nonzero value, 37, until the draft canvas appeared. Each warm scrub delivered six input events and held the last value, 20, until one draft canvas appeared. Draft latency runs from the input listener to the new stage canvas observed in the DOM. The heartbeat samples main-thread scheduling at a nominal 10 ms interval. Commit latency runs from the release-generated `change` event to the next canvas publication. The measurement includes a subsequent animation-frame observation and does not measure physical presentation.

| Processing | Cold draft latency / max gap | Warm final-input latency / max gap | Cold / warm commit latency | Renderer / GPU peak working set through warm commit |
| --- | ---: | ---: | ---: | ---: |
| Original | 5,581.4 / 185.8 ms | 739.3 / 110.4 ms | 2,386.5 / 2,311.6 ms | 1.771 / .827 GB |
| Linear | 4,480.2 / 92.7 ms | 281.3 / 90.4 ms | 1,358.3 / 1,336.7 ms | 2.068 / .136 GB |

From the first warm input through publication, Original took 1,281.1 ms and Linear 685.3 ms. Renderer working sets before the gesture were .235 and 1.043 GB, respectively. At cold draft publication the cumulative renderer high-water marks were 1.297 and 1.625 GB, and GPU marks were .521 and .131 GB. These are OS per-process working-set measurements in decimal GB. The separate peaks include fixture and surface allocations and need not be simultaneous.

Independent Node PNG decoding found that each draft differed from neutral and matched its freshly published committed canvas in all 3,717,788 RGBA channels. Undo restored strength 37 and original export matched all 1,472,342 source bytes in each host. No dehaze worker fallback was reported. These are single Windows observations with one cold and one warm gesture per mode. The executable build succeeded with `-skip-installer` after the NSIS download failed. The ignored runner, raw events, PNGs and logs are `.workspace/dehaze-native-slider.mjs`, `.workspace/24mp-native-slider-detail/`, `.workspace/24mp-native-slider-detail.log` and `.workspace/24mp-native-build*.log`.

### Release-to-commit phase trace

A separate run of the same executable observed the existing worker messages, canvas JPEG callback, IndexedDB transaction and stage canvas replacement. It measured the warm release as follows. The small intervals between the JPEG callback and the database request are included in the total.

| Processing | Release to 240×160 JPEG request | JPEG request to callback | IndexedDB transaction | Transaction complete to stage publication | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original | 661.3 ms | 1,011.3 ms | 1.7 ms | 654.8 ms | 2,329.7 ms |
| Linear | 83.1 ms | 1,008.4 ms | .8 ms | 256.1 ms | 1,349.3 ms |

The cold release also waited 1,004.6 ms (Original) or 1,010.4 ms (Linear) for the thumbnail JPEG callback. The renderer reused its prepared dehaze source and analysis. Original still ran the full-size 6000×4000 encoding worker twice during commit, once before the exact thumbnail render and again before the stage render. Linear requested separate 240×160 and 1181×787 reconstructions. The independently rendered JPEG bytes matched the active filmstrip tile in each phase. FFmpeg decoded each thumbnail, and the stage PNG and original comparisons passed again. The approximately one-second JPEG interval is consistent with Blink's desktop idle-encoding startup deadline. The WebView trace observes the API callback and does not establish the encoder's internal scheduling branch. [Blink canvas encoder](https://chromium.googlesource.com/chromium/src/+/lkgr/third_party/blink/renderer/core/html/canvas/canvas_async_blob_creator.cc)

### Thumbnail JPEG API comparison

The same Windows executable retained the actual 240×160 thumbnail canvases from both cold and warm releases in both modes. Once those workflows settled, it encoded each canvas three times with each API at JPEG quality .92. Three cyclic orders put each API in each position once per canvas, and the warm trials reversed the cold order. The Offscreen candidate included copying the existing canvas's RGBA samples to a fresh offscreen surface. The data URL candidate included decoding base64 into a JPEG Blob. The measurement ended once each Blob was ready, before byte comparison and independent decoding.

| API | Elapsed range | Longest 10 ms heartbeat gap |
| --- | ---: | ---: |
| HTML Canvas `toBlob` | .6–12.5 ms | 11.2 ms |
| HTML Canvas `toDataURL` and Blob conversion | .5–3.1 ms | 3.1 ms |
| OffscreenCanvas `convertToBlob` including pixel copy | 1.8–4.9 ms | 4.9 ms |

All 36 JPEGs matched the respective filmstrip thumbnail bytes and all 153,600 independently decoded RGBA channels. Encodes completing before the first heartbeat used their measured elapsed time as the scheduling gap. The one-second callback wait did not recur when calling the APIs after the workflow settled. Ignored phase and encoder evidence is `.workspace/24mp-native-slider-phase/`, `.workspace/24mp-native-slider-jpeg/` and the corresponding `.log` files.

### Matched live thumbnail commits

The next run used the same executable and gesture in twelve fresh native hosts, three baseline/candidate pairs per processing mode. The order reversed between consecutive pairs and was counterbalanced across modes. The candidate substituted `toDataURL` and JPEG Blob conversion only for the 240×160 commit thumbnail on the same HTML canvas. Both variants still used the existing thumbnail render, stored its output, and rendered a new stage canvas. The live thumbnail encode waited 1,003.5–1,011.4 ms with `toBlob`, compared with 2.9–16.9 ms for the candidate.

| Processing and release | Baseline release to stage | Candidate release to stage |
| --- | ---: | ---: |
| Original, cold | 2,300.3–2,645.8 ms | 1,243.3–1,317.0 ms |
| Original, warm | 2,250.6–2,740.7 ms | 1,276.8–1,397.7 ms |
| Linear, cold | 1,353.4–1,375.6 ms | 363.4–386.4 ms |
| Linear, warm | 1,351.1–1,383.5 ms | 346.6–403.3 ms |

Across all twelve paired releases, each committed thumbnail matched its baseline JPEG bytes and all 153,600 independently decoded RGBA channels. Each committed canvas matched all 3,717,788 baseline channels. All drafts matched their own committed canvases, undo restored strength 37, and exported original bytes matched. This was a Windows runtime substitution in the ignored harness. The measurement covers commit latency and leaves the earlier cold analysis and draft latency as separate costs. Exact inputs, order and comparison results are in `.workspace/24mp-native-slider-live-jpeg/` and `.workspace/24mp-native-slider-live-jpeg.log`.

### Shared catalog thumbnail encoding

The production `encodeThumbnail` consumes the existing canvas after rendering at a maximum edge of 240 pixels. It requests JPEG quality .92 and returns its bytes as an `image/jpeg` Blob. It serves import, catalog refresh, edit and undo, Local folder hydration, enhancement, merge, migration and sync. Full-size image encoding retains the asynchronous export APIs. Slider release still renders the thumbnail, persists the edit and publishes the committed viewport. The change avoids the measured JPEG callback wait without sharing viewport surfaces with thumbnail rendering.

The focused browser regression compares the previous and new JPEG bytes and decoded pixels for opaque and varying-alpha canvases, including a small thumbnail. It also compares cropped Original and Linear thumbnails after an edit, verifies the same thumbnail and recipe after reopening the catalog, and checks that an encoder failure preserves the prior edit, thumbnail and original bytes. Related browser coverage holds the real asynchronous catalog write to test that queued stale controls, sampling and straightening retain their existing ownership. Run `node --test tests/thumbnail.test.js` for the encoder and persistence checks.

A freshly built Windows package reproduced the benefit with the production encoder and no runtime substitution. Original cold and warm releases published the canvas in 1,256.4 and 1,277.8 ms, with 2.7 and 2.9 ms from the JPEG request to its Blob entering catalog serialization. Linear published in 387.3 and 351.5 ms, with JPEG intervals of 17.2 and 4.2 ms. The four thumbnails matched the old packaged encoder byte for byte and across all 153,600 independently decoded channels each. Each committed stage matched all 3,717,788 old-encoder channels. In both hosts, undo restored the prior strength, stale-target and forced encoder failures preserved the recipe, and original export matched all 1,472,342 bytes. The two-mode run used the same Windows/WebView2 environment described above. Evidence is `.workspace/24mp-native-slider-production-jpeg/` and `.workspace/24mp-native-slider-production-jpeg.log`.

## Production byte encoding (2026-11-06)

The shared `linearFrameToRgba8` now uses `srgb-byte-encode.js` with the chosen 20-bit prefix table and scalar fallback at quantization boundaries. An independent scalar test exercises all 255 byte transitions and neighboring Float32 values, plus source-alpha, rounding, view-offset and validation contracts. Real Chrome encoding-worker bytes are compared before resizing, alongside cancellation and deliberate startup fallback. This does not change analysis resolution, floating reconstruction or profile-aware export encoding.

The 6000×4000 haze scene defined below was generated as a Float32 frame. `frameCanvas` created the display bitmap; Linear additionally associated that bitmap with its float source. Generation/display setup was excluded, so the main-realm table was already initialized, while each encoding worker still constructed its own table. Fresh Chrome 156 instances compared the `67e0a41` scalar converter against the actual production module, scalar first for each process version, with identical module-routing conditions. All 4,367,360 final RGBA samples per strength/version matched; no worker startup fallback was reported.

| Process / implementation | First 40 elapsed / max gap ms | Cached 70 elapsed / max gap ms | Cached 20 elapsed / max gap ms |
| --- | --- | --- | --- |
| Original scalar | 8131.9 / 541.2 | 1794.6 / 123.3 | 2070.0 / 118.2 |
| Original production | 6342.0 / 700.5 | 638.4 / 67.5 | 658.0 / 76.5 |
| Linear scalar | 6308.8 / 467.1 | 304.8 / 94.3 | 308.8 / 88.4 |
| Linear production | 5992.0 / 610.4 | 308.1 / 89.5 | 327.5 / 80.3 |

Original cached completion improved in this observation. Linear total latency did not show a clear improvement, and both first-operation maximum gaps worsened. This is neither a latency distribution nor a claim of smooth large-image dragging; first source preparation, copying, canvas work and memory costs remain. Process peak memory was not measured here. Each table is 520,194 bytes per initialized realm, not a measured process-memory delta. Ignored evidence: `.workspace/srgb-production-integrated.mjs/.json/.log`. Earlier observations below retain their original implementation and fixture boundaries.

## Empty Linear source corrections (2026-11-06)

`correctedFrame` still copies the original and validates the owned Float32 frame. When fill/red-eye lists are absent or empty and both local tools and optics are undefined, it now returns that validated copy directly. Previously the four identity stages each scanned every sample. Present local/optics recipes, including neutral recipes, retain their stage-owned behavior and validation; this does not duplicate their activity rules or alter active correction order.

The isolated Chrome 156 experiment used a 6000×4000 signed/HDR Float32 frame with fractional alpha. Three repetitions alternated four-stage and single-validation order (reversed in the middle). Copy plus four empty stages took 550.8, 589.6 and 966.5 ms; copy plus one validation took 165.6, 183.1 and 228.0 ms. All samples were compared exactly, and each result retained its owned buffer. This measures the absent-correction case, not active edits.

An actual `renderPrepared` comparison used the same 24MP haze scene and bitmap/Linear binding described above. Fresh Chrome 156 instances routed `render.js` from `daf0a11` and the changed working copy under identical routing conditions, baseline first. Both retained the production byte encoder. At strengths 40/70/20, all 4,367,360 final RGBA samples per output matched and worker diagnostics were empty.

| Implementation | First 40 elapsed / max gap ms | Cached 70 elapsed / max gap ms | Cached 20 elapsed / max gap ms |
| --- | --- | --- | --- |
| Four identity stages | 5474.2 / 494.4 | 312.4 / 71.5 | 324.1 / 73.2 |
| One validation | 6089.9 / 281.1 | 357.7 / 71.0 | 357.7 / 81.3 |

The measured first main-thread gap fell, but total completion worsened in this single observation. This supports removing redundant synchronous scans, not a claim of lower total latency or smooth interaction. Background activity was uncontrolled; no process-memory measurement or other-engine performance measurement was made. Copying, one full validation, active source corrections and canvas work remain. Ignored evidence is `.workspace/empty-source-stages.mjs/.json/.log` and `.workspace/source-preparation-integrated.mjs/.json/.log`. The tracked `tests/source-preparation.test.js` checks actual prepared and rendered samples against explicit stage composition, source isolation and malformed frame rejection.

## Cold Linear phase breakdown and grouped validation (2026-11-06)

Six fresh Chrome 156.0.8078.80 processes rendered the same 6000×4000 Float32 haze fixture through `renderPrepared` at edge 1280 and strengths 40, 70 and 20. The trial order was baseline, grouped validation, moment-row reuse, then the reverse. The baseline used `cb64646` renderer modules, and routes added the same phase instrumentation to all trials. Source fixture generation and final pixel comparison were outside the timed interval. The comparison checked all 4,367,360 canvas RGBA bytes at each strength against the baseline. Every byte matched and worker startup fallback was absent.

| Variant | First preview ms | First maximum heartbeat gap ms | Main validation ms | Worker validation ms | Peak active renderer GB |
| --- | --- | --- | --- | --- | --- |
| Baseline | 4909.2 / 5023.1 | 143.1 / 144.8 | 93.7 / 95.3 | 104.1 / 102.8 | 1.595 / 1.595 |
| Grouped RGBA validation | 5051.6 / 4909.2 | 107.3 / 109.5 | 55.8 / 53.3 | 58.2 / 54.8 | 1.595 / 1.598 |
| Reuse one row of Float64 moments | 4840.1 / 4903.1 | 142.8 / 155.1 | 95.3 / 104.0 | 117.6 / 103.6 | 1.592 / 1.598 |

Baseline source copying took 41–42 ms and the two weighted-moment passes took 2.70–2.86 s together. Cold reconstruction including its owned copies took 223–233 ms, followed by about 39–41 ms of display encoding. The grouped scan lowers the measured synchronous validation and first heartbeat gap, while total completion overlaps the baseline. It retains dimensional checks, signed finite RGB, alpha in `[0,1]` and the same `TypeError` before worker transfer. The production validator now checks one RGBA pixel per iteration. The row-reuse candidate preserves the compensated accumulation order and matched four small signed and transparent map fixtures. Its measured gap did not improve consistently, so it remains research-only.

Renderer working-set peaks include fixture surfaces and caches and stay near 1.60 GB. Separate GPU process peaks were about 0.50 GB. This isolated Linear test excludes active source corrections, image decode, Original canvas readback, and the thumbnail and catalog commit path. The six runs show neither a latency distribution nor native WebView behavior. Ignored reproduction and evidence are `.workspace/dehaze-cold-breakdown.mjs`, `.json` and `.log`.

## Original measurement environment

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
