# Dehaze analysis-scale ablation

Executed 2026-11-05 on Windows / Node 24.9.0. This record evaluates a possible approximation after the first 24-megapixel exact implementation showed unacceptable latency. It is not a production algorithm change. Run `node --expose-gc research/dehaze-scale-ablation.mjs`; detailed output is written to ignored `.workspace/dehaze-scale-ablation.json`.

## Experiment

The reference calls the shared exact `analyzeDehaze` at source resolution. Each candidate first builds an alpha-weighted area-average RGB proxy with maximum edge 512, 1024 or 2048, then calls the same analysis on that proxy. Proxy alpha is mean coverage; RGB divides weighted premultiplied sums by total coverage, excluding zero-alpha hidden values. Reconstruction samples proxy transmission bilinearly at full-resolution pixel centers, uses the proxy's airlight, and applies the +100 reconstruction to the unchanged original linear RGB. Only analysis resolution differs. Image dimensions do not depend on the later preview/export/crop request.

Two generated 3072×2048 scenes contain continuously varying color and single-pixel black anchors at grid spacing 3 or 17. A 32-row airlight strip uses A=(.85,.9,1). Known transmission is .35 on the left and .8 on the right. This deliberately dark-channel-compatible fixture exposes loss of small dark evidence during area averaging. Its airlight strip is excluded from error metrics.

The third input is the existing [public-domain NASA astronaut fixture](../tests/fixtures/ai/README.md), decoded by the PNG input path and bilinearly enlarged from 512×512 to 3072×3072 before adding the same synthetic depth discontinuity and airlight. Its original enlarged pixels are the target for removing this added veil; they are not asserted to be naturally haze-free ground truth. Enlargement creates no new photographic detail, and this is not a natural 9- or 24-megapixel camera photograph. Unlike the generated cases, it contains no inserted airlight strip.

All metrics use unbounded linear RGB, before gamut clipping or byte quantization. Edge MSE covers the 17 columns centered on the synthetic depth boundary. It measures boundary reconstruction error; it is not proof that an output is perceptually halo-free.

## Measured quality

| Input                     | Analysis edge | MSE against pre-veil target | Edge MSE against target | MAE against exact output | Maximum RGB difference from exact |
| ------------------------- | ------------: | --------------------------: | ----------------------: | -----------------------: | --------------------------------: |
| Anchor spacing 3          |         Exact |                   .00215187 |               .03148264 |                        0 |                                 0 |
| Anchor spacing 3          |           512 |                   .01488946 |               .02989317 |                .11345776 |                        1.40718671 |
| Anchor spacing 3          |          1024 |                   .01445854 |               .02901578 |                .11075823 |                        1.18212964 |
| Anchor spacing 3          |          2048 |                   .00675235 |               .02663447 |                .07775766 |                         .60762302 |
| Anchor spacing 17         |         Exact |                   .00158293 |               .01893886 |                        0 |                                 0 |
| Anchor spacing 17         |           512 |                   .01553308 |               .02753338 |                .11870760 |                        1.14482766 |
| Anchor spacing 17         |          1024 |                   .01163808 |               .02461531 |                .10427400 |                         .80916253 |
| Anchor spacing 17         |          2048 |                   .00392235 |               .01980436 |                .06468070 |                         .49587850 |
| Enlarged astronaut + veil |         Exact |                   .02931900 |               .04149753 |                        0 |                                 0 |
| Enlarged astronaut + veil |           512 |                   .02947700 |               .04667815 |                .00343802 |                         .17733458 |
| Enlarged astronaut + veil |          1024 |                   .03029262 |               .04252210 |                .00368539 |                         .13511192 |
| Enlarged astronaut + veil |          2048 |                   .02991822 |               .04129722 |                .00239875 |                         .06215850 |

All generated candidates retained the correct airlight within Float32 rounding. Therefore their large errors come primarily from the loss of dark-channel evidence and resulting transmission changes, not a wrong airlight estimate. At edge 2048 the maximum transmission difference was .3892 (spacing 3) and .3827 (spacing 17). In the spacing-3 case, components outside display [0,1] rose from .016% for exact analysis to 8.531% for edge 2048, and 9.984% for edge 512. Reconstruction remains unclipped; these values predict more output-boundary clipping, not a numerical failure to preserve HDR.

The photographic case is closer to the reference on average, but cannot override the controlled failure. Its exact estimated airlight (.96305,.97876,.99310) also differs from the generating airlight, showing that exact estimation itself is not a perfect inversion for arbitrary photographs. Approximation quality is not monotonic for every metric: 1024 has slightly larger target MSE than 512 in this case. Selecting a scale from this single image would be unjustified.

An independent alpha check changed hidden RGB from extreme signed values to different values while retaining identical visible RGB and alpha. The 96×64-to-32-edge area proxies, estimated airlight and transmission were exactly equal. This establishes hidden-RGB exclusion for the tested reduction, not comprehensive alpha-edge visual equivalence.

## Observed latency and limitations

| Input                     | Exact analysis (ms) | Edge 512 (ms) | Edge 1024 (ms) | Edge 2048 (ms) |
| ------------------------- | ------------------: | ------------: | -------------: | -------------: |
| Anchor spacing 3          |                9435 |           242 |            691 |           4905 |
| Anchor spacing 17         |               10072 |           214 |            602 |           5145 |
| Enlarged astronaut + veil |               18846 |           282 |           1006 |           7410 |

Candidate times include area reduction and analysis, but exclude metric calculation and full-image reconstruction. These wall-clock observations used the earlier full-plane exact implementation loaded when the process started; other development jobs were active on the machine. They are not isolated benchmarks or current post-optimization timings. The exact domain was subsequently optimized separately; its current performance belongs in the final acceptance measurements. Neither this comparison nor the original 24MP latency establishes a universal hardware limit.

## Decision

Reject fixed-resolution RGB proxy analysis at all three tested scales as a transparent substitute for the exact source-resolution operation. The speedup does not justify large content-dependent reconstruction errors, even at edge 2048. Do not silently lower final export quality or introduce preview/export-dependent analysis. Keep the exact source analysis and pursue equivalent memory/loop improvements plus reconstruction fused with downstream geometry. Any future approximation, including full-resolution dark evidence with only coarse guided refinement, needs its own quality experiment; it is not validated here.
