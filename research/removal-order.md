# Removal order experiments

The [earlier runtime comparison](preview-consistency.md#mask-coverage-and-removal) separated an incorrect range reference from an independently existing fill-before-clone limitation. These observations concern OpenLR, not Lightroom's internal implementation. The new [decision](../docs/decisions/020-ordered-removal.md) preserves old recipes while making later retouch operations effective.

## Stage ablation

An actual Chrome experiment ran 40 cases: exact `b06a522`, the `7dc0d11` behavior, an all-fills-after-repairs candidate, and a new-fills-only-after-repairs candidate, across Original/Linear processing and range/radial/soft/transparent/historical fixtures. The two candidates used temporary browser module overrides, not production code. Script and complete numeric output are retained in ignored `.workspace/removal-stage-ablation.mjs`, `.json` and `.log`.

Both later-stage candidates removed the cloned 3×3 red target from `[245,29,22,255]` to `[96,96,96,255]`, changing exactly nine pixels and none outside the selection. Moving all fills changed nine historical pixels: the clone no longer sampled the old fill. Keeping old fills in place preserved that historical image exactly in both processing versions. Every original file stayed byte-identical.

With a 55% clone and 50% removal coverage, sequential new-stage Original samples were `[178,59,55,255]` → `[137,77,75,255]` → `[116,86,85,255]`; Linear samples were `[196,69,68,255]` → `[157,84,83,255]` → `[131,90,90,255]`. An independent calculation from emitted patch alpha and the appropriate transfer function matched within one byte per channel. For alpha-155 input, staged target alpha became 205 and then 230, consistent with source-over. All 32 removal rows preserved exterior samples and original bytes.

The fixed candidate still places future clones underneath removals by construction. The implementation therefore adds stable repair-to-fill anchors. `tests/removal-layers.test.js` verifies Clone → Remove → Clone → Remove through the real dispatcher, both processing versions and opaque/partial repairs; it also checks old patch order, unaffected pixels, editable repairs, undo/redo, named versions, XMP, selective copying, rejected malformed input and persistent reload. The shared compositor retains precise Linear samples outside patches. Native coverage is extended in `scripts/native-mask-smoke.mjs`; platform execution and full regression results belong in [acceptance](../docs/acceptance.md).

The new encoded-byte compositor reuses the existing bounded source-over loop with encoded patch samples and normalized alpha. Historical Canvas composition remains unchanged. This avoids a whole-image Canvas round trip between repairs and masks, which could quantize unselected partially transparent pixels. The Linear compositor decodes only patch samples; it does not convert the entire working frame back from byte data.
