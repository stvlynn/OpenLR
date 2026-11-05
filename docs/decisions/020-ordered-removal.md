# Ordered content-aware removal

## Status

Accepted.

## Context

The renderer historically applied baked fills before red-eye and Clone/Heal. A real Chrome comparison showed that an opaque clone could completely cover a successful removal. Moving every fill later fixes that case but changes existing photographs: a clone which sampled a historical fill starts sampling the original blemish. Original files, existing recipes, float samples outside a patch, and subsequent editable strokes must remain intact.

## Decision

Keep historical `edit.fills` in their original stage. Store new solver results in `edit.postRepairFills`, using the same bounded RGBA8 payload and shared fill compositors. Each new patch has a stable ID. A repair created after a staged fill records the latest fill ID as `afterFillId`; older repairs remain unanchored. The shared pre-mask source owner applies historical fills and red-eye, then unanchored repairs, then each new fill and the repairs anchored after it. Thus Clone → Remove → Clone → Remove follows creation order without migrating old images or flattening editable recipes.

Updating a repair preserves its position. Deleting it does not renumber anything. A repair whose anchor is absent after selective paste executes after the current last fill, or in the ordinary repair group if there are no fills. Before another removal is appended, those missing anchors are resolved to the position actually used for that solve. Otherwise a missing anchor would keep moving after each new patch and overwrite the new removal again. Original relative order within each group is retained.

Mask coverage and the solver read the same uncropped pre-mask raster, including previous removals. Original processing uses owned encoded pixels; Linear retains an owned float coverage reference and creates a separate RGBA8 solver input. Only the selected patch is quantized and composited back. Blur, mask adjustments, optics and later global operations follow retouching. The original image is never rewritten.

XMP validates the staged collection and its unique IDs; ordinary repair commands cannot supply the internal ordering field. GUI and CLI capture it through the same dispatcher. Named versions, undo and catalog persistence retain whole recipes. The existing Content-aware removal copy category includes both fill collections. Copying repairs independently uses the missing-anchor rule. Older XMP readers reject the unknown top-level collection rather than treating new patches as historical fills; older catalog readers are not promised forward-compatible rendering.

## Alternatives considered

- Moving every fill after repairs changed nine historical fixture pixels in both processing versions. Rejected.
- A fixed topmost stage for new removals preserved old images, but would also cover newly drawn clones. Stable anchors retain the required subsequent interaction without an unrelated full edit-history engine.
- Baking the entire corrected source loses editable state and float precision outside the patch, or applies corrections twice when their recipes remain. Rejected.
- Refusing overlaps leaves an ordinary editing operation unavailable. Rejected.

## Consequences

Removal operates on the visible retouched source before local/global adjustments. Existing fill behavior is unchanged, including its old precision and order. New fills remain explicit 8-bit sRGB patches; this is not a high-depth RGB inpainting solver. Soft coverage uses source-over in the processing space, and can increase alpha inside the selected area; exterior samples remain untouched. Ordering metadata is owned by the application, not another UI control or a separate CLI implementation.

## References

- [Experiments and verification](../../research/removal-order.md)
- [OpenCV 5.0.0 inpaint implementation](https://github.com/opencv/opencv/blob/5.0.0/modules/photo/src/inpaint.cpp): multi-channel input is 8-bit RGB; floating input is single-channel.
- [OpenCV inpainting tutorial](https://github.com/opencv/opencv/blob/5.0.0/doc/py_tutorials/py_photo/py_inpainting/py_inpainting.markdown), also checked through Context7.
- [Darktable retouch documentation](https://github.com/darktable-org/dtdocs/blob/master/content/module-reference/processing-modules/retouch.md): independent prior art for uncropped editable retouching, not OpenLR's solver or ordering contract.
