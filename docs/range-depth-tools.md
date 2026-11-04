# Range masks, composite masks and depth focus

Open **Masks & local repair**. **Create color range** selects pixels near an sRGB reference color. Enter a color or use **Sample range color** then click the image. Sampling follows the inverse crop, rotation, flip and optics mapping to the original decoded pixel. Tolerance is the accepted RMS RGB distance in 0..1; Softness is its smooth transition width. This original OpenLR distance rule is not a claim to reproduce Adobe's unpublished color metric.

**Create luminance range** uses linear-light sRGB relative luminance (`0.2126 R + 0.7152 G + 0.0722 B`). Minimum/maximum are inclusive; softness fades outside that interval. These ranges evaluate the immutable pre-mask pixel buffer, after repairs and before global edits, so earlier exposure masks cannot move the selection. New masks inherit the local adjustment controls. Later changes to Range fields refine the selected range mask. Preview, thumbnails and exports evaluate the same recipes in original coordinates.

Choose a mask and **Combine with** another, then **Add mask**, **Subtract mask** or **Intersect mask**. This consumes the second top-level mask into a two-component group. Its coverage participates; its separate adjustments do not. The first mask's adjustments apply once to the combined coverage. Soft union is `a+b−ab`, subtraction `a(1−b)`, intersection `ab`. Components retain their geometry, raster, strength, inversion and enable state. **Component** chooses a nested component for range/geometry/strength edits; **Whole mask** controls the group's adjustments. **Operation** can change an existing group's combination. Nested geometry is editable through the same CLI changes. Remove deletes the selected group.

## Real relative depth

**Apply lens blur** and **Create depth range** estimate a real depth map on first use with Depth Anything V2 **Small**, Apache-2.0, through ONNX Runtime Web 1.31.1 WASM CPU. The unmodified quantized ONNX is 27,258,801 bytes at [fixed ONNX revision](https://huggingface.co/onnx-community/depth-anything-v2-small/tree/4472b7362082ad9968fee890ca0f1e5aca36b93d). The Small model is Apache-2.0; Base/Large/Giant have noncommercial terms and are not used. Original license and small-model card are retained in `web/models/`; exact sources, measured timings and outputs are in [depth research](../research/depth-tools.md).

Preprocessing follows its DPT configuration: RGB/255, ImageNet mean/std, aspect-preserving lower-bound 518-pixel resize rounded to a 14-pixel patch multiple. Output is min–max normalized **relative inverse depth: 0 far, 1 near**. It is not metres or calibrated physical focal distance. Monocular estimates can be wrong on mirrors, transparency, thin edges and unfamiliar scenes. No color threshold, semantic silhouette or constant depth substitutes for failed inference.

The weight downloads once from the fixed revision and uses the shared atomic ArrayBuffer-chunk cache under the `depth` key; there is no duplicate HTTP disk-cache copy and no hash allowlist gate. Images remain on the device. Visible download, parse, storage, inference or allocation failures leave edits unchanged. Workers and startup fallback share one inference kernel. The normalized depth raster and source metadata persist in the edit recipe; ordinary focus/range changes and later exports reuse it without inference. A failed Worker startup uses the same main-thread kernel; processed model errors are not retried as a different algorithm.

Lens blur's **min/max** choose the in-focus interval. **amount** is a blur radius fraction of the original short edge; **softness** controls the depth transition to full defocus. Focused pixels stay unchanged. Near and far defocus planes each use three separable box passes (a Gaussian approximation), normalized by depth coverage and premultiplied alpha. In-focus source colors are excluded from both blur fields, reducing subject-color bleed. Depth distance blends sharp/blurred pixels. This is a deterministic depth-guided blur, not a calibrated aperture simulation, disk-bokeh model, occlusion reconstruction or generative fill; broad halos and depth-boundary mistakes remain possible. Work/memory scale with decoded pixel count; resource failures are reported, not hidden behind an arbitrary file-size cap.

Depth range uses the same min/max/softness convention to apply local exposure, contrast or saturation. It composes with procedural and semantic masks through the existing coverage system.

## Shared CLI

```powershell
node cli/openlr.mjs mask.add --args '{"mask":{"type":"color-range","color":"#1464b4","tolerance":0.05,"softness":0.1,"adjustments":{"Exposure":0.5}}}'
node cli/openlr.mjs mask.add --args '{"mask":{"type":"luminance-range","min":0.1,"max":0.4,"softness":0.05,"adjustments":{"Saturation":-30}}}'
node cli/openlr.mjs mask.combine --id FIRST --operandId SECOND --operation intersect
node cli/openlr.mjs mask.component-update --args '{"id":"GROUP","path":[1],"changes":{"min":0.2}}'
node cli/openlr.mjs depth-estimate
node cli/openlr.mjs depth-range --args '{"min":0.15,"max":0.5,"softness":0.05,"adjustments":{"Exposure":0.5}}'
node cli/openlr.mjs lens-blur --min 0.2 --max 0.5 --amount 0.025 --softness 0.15
node cli/openlr.mjs lens-blur --enabled false
```

An optional `photoId` guards queued UI/CLI operations. The normal undo/redo, persistence and original-file preservation rules apply. `tests/range-masks.test.js` verifies actual UI range/composite/component editing, transformed export pixels and restart persistence; `tests/depth.test.js` verifies real model inference, focused pixels unchanged, defocused pixels changed, depth range, first-use cache/restart and Worker startup fallback. Tests explicitly skip optional-weight inference when its ignored research file has not been downloaded; pure coverage/blur tests always run. `tests/model-cache.test.js` verifies Blob-incompatible writing, legacy Blob/ArrayBuffer reading and atomic replacement of model chunks.
