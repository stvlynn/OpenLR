# Crop composition guide evidence and rendering comparison

Reviewed 2026-11-05. Product behavior is defined in [crop guides](../docs/crop-guides.md). This record does not promote competitor labels into an exact-rendering requirement.

## Prior evidence and sources

- Existing OpenLR `web/crop-surface.js` owned draft coordinates and eight resize handles; `web/workspace.css` drew fixed thirds using CSS gradients. There was no selectable guide, shared command or state field. The crop dispatcher already provided draw/nudge/cancel/commit and the browser test already exercised pointer/agent equivalence. Reusing that surface avoids another image or input pipeline.
- The Windows Lightroom 9.4 runtime observation is recorded separately in [Lightroom research](lightroom.md). It establishes the nine menu choices, not their mathematical definitions, display conditions or exact geometry. No Adobe code, resources, strings file or screenshot asset is incorporated into OpenLR.
- The open-source darktable [guide manual](https://darktable-org.github.io/dtdocs/en/module-reference/utility-modules/darkroom/guides-overlays/) describes globally owned guide settings, module-local display, and horizontal/vertical flipping of asymmetric guides. Its [src/gui/guides.c](https://github.com/darktable-org/darktable/blob/master/src/gui/guides.c) was inspected through the public source page on this date: `dt_guides_draw_golden_mean` composes scaled Cairo arcs; the common guide draw wrapper applies horizontal/vertical mirror transforms and overlay strokes. This is source inspection, not a darktable runtime test. The source page was master and is not a fixed vendoring revision. No source is copied or adapted; in particular OpenLR uses an independently generated logarithmic spiral rather than the inspected arc construction.
- W3C [SVG interactivity](https://www.w3.org/TR/SVG/interact.html) specifies pointer hit testing; [vector effects](https://dev.w3.org/SVG/modules/vectoreffects/master/SVGVectorEffects.html) documents non-scaling strokes. Native SVG APIs suffice; no new third-party library or Context7 package integration is required. OpenLR's geometry uses actual crop-frame CSS pixels; the overlay passes input to the existing crop handles and canvas.

## Small rendering ablation

`node tests/crop-guide-ablation.mjs` was run on Windows 10 / HeadlessChrome 155.0.0.0 / DPR 1. It compares the previous CSS-gradient approach, a transparent SVG path, and a separate transparent Canvas2D surface for the same four thirds lines. Seven rounds of 1,000 updates are measured; the median includes JavaScript mutation plus forced DOM layout reads. Geometry is precomputed. The measurement **does not measure GPU paint completion**, full photo rendering, pointer latency or the production two-stroke/label cost. Identical repeated attributes can be optimized by the browser. It is a small feasibility comparison, not an application benchmark or a performance gate.

| Frame | CSS milliseconds / 1,000 | SVG milliseconds / 1,000 | Canvas2D milliseconds / 1,000 |
| --- | ---: | ---: | ---: |
| 480 × 300 | 3.3 | 5.5 | 3.1 |
| 180 × 500 | 2.9 | 4.9 | 2.0 |

All candidates are cheap for the measured simple lines. CSS gradients are concise for divisions but do not naturally express a logarithmic spiral, perpendicular construction or ratio labels. Canvas supports them but needs another raster surface, DPI sizing and redraw ownership. SVG supports all nine geometries, fixed CSS stroke widths, labels and pointer transparency in the existing crop DOM. Its small measured mutation overhead does not justify a second raster pipeline. OpenLR therefore removes the old fixed CSS thirds and uses one SVG overlay for every guide, with dark/light strokes for visibility on light and dark photos. The independent pure geometry function is shared by the overlay and numerical tests.

## Actual image and state verification

`node --test tests/crop-guides.test.js tests/crop.test.js` passed all five tests in local Chrome after allowing the temporary localhost server outside the network sandbox (the first sandboxed run failed navigation with `ERR_NETWORK_ACCESS_DENIED`). The guide test checks every UI option, serialized dispatcher results and UI synchronization, export PNG bytes, unchanged canvas pixels/recipe/draft, resized on-screen coordinates, pointer movement through guide strokes, and crop commit excluding guide settings. Synthetic RGB fixtures are generated in the test; there are no personal or proprietary photos.

The explicit ablation script also captures actual synthetic-photo UI screenshots to ignored `.workspace/crop-golden-spiral.png`, `.workspace/crop-aspect-ratios.png` and `.workspace/crop-guides-narrow.png`. They are visual QA outputs, not tracked source assets. Inspected 1440 × 960 and 900 × 700 layouts: guides stay inside the current draft, ratio labels remain readable, and the right inspector can scroll to the controls. Guide orientation is shown only for asymmetric modes. Exact Lightroom pixel equivalence, auto visibility, keyboard cycling and user-defined ratio lists are not claimed.
