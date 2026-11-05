# Point and channel tone curves

Open **Point curve** in the detail inspector. Select RGB, Red, Green or Blue; click the graph to add a point, or use Add point to insert one in the largest gap. Drag a point or change its Input/Output values. Endpoints stay at input 0 and 1 but their output can move. Delete point removes an interior point; Reset channel restores only the selected channel. Other channels and the original three Curve sliders remain unchanged.

The point dropdown and graph share the selected point. With the graph focused, arrow keys move that point by 0.01, Shift-arrow by 0.1, and Delete/Backspace removes it. Escape cancels an active drag. The graph and photo preview update during dragging, but a completed drag creates only one saved edit and one undo entry. Cancelling restores the committed preview. Preview painting checks the active photo, edit reference, decoded source and processing version; stale scheduled painting cannot replace a newly selected photo. A changed source photo or channel curve rejects a stale commit before saving. Concurrent unrelated edits are preserved because the command replaces only its explicit curve channel in the current recipe.

## Shared commands and state

GUI controls dispatch the same discoverable commands used by the CLI:

```sh
node cli/openlr.mjs schema curve-set
node cli/openlr.mjs curve-channel --channel red
node cli/openlr.mjs curve-set --channel red --points '[{"x":0,"y":0.1},{"x":0.5,"y":0.6},{"x":1,"y":1}]'
node cli/openlr.mjs curve-select --index 1
node cli/openlr.mjs preview --output curve-preview.png
```

`curve-channel` and `curve-select` change session selection without modifying recipes or history. Full and summary `state` include `toneCurve: {channel,index}`. Changing photos resets the point index; the channel remains selected. `curve-set` replaces one channel's points and optionally selects `index`. Optional `photoId` guards the active photo, and `expectedPoints` guards the previous points in that channel. These are guards, not alternative source selectors. Omitted guards retain ordinary execution-time behavior. Invalid input or a failed save does not add history. An identical replacement changes no stored recipe or undo history.

## Recipe and rendering contract

The `toneCurves` recipe owner contains optional `rgb`, `red`, `green` and `blue` arrays of `{x,y}`. Coordinates must be finite and within [0,1], with at least two points, strictly increasing x, and endpoint x values 0 and 1. Unknown channels and point properties are rejected. There is no arbitrary point-count limit. Y values may rise or fall. Missing channels are identity. Reset removes the channel's two identity endpoints; an empty owner is removed. Additional identity knots remain editable and persist, but do not alone mark a photo Edited.

`web/tone-curves.js` owns validation, channel updates and the shape-preserving PCHIP evaluator shared by the graph and renderer. The [research and ablation](../research/point-tone-curves.md) record the mathematical sources and selected interpolation. Compilation happens once per recipe. The existing three-slider curve runs first, then the RGB master on each component, then that component's channel curve, followed by the existing color mixer. The master is a component curve, not a luminance operation. Alpha and original samples remain unchanged.

Original processing retains its existing byte operations and applies new per-channel lookups after the old curve. Absent or identity point curves preserve old outputs. Linear processing evaluates in continuous signed encoded sRGB, composing master and channel before decoding, without an intermediate byte lookup or clipping. Outside normalized input [0,1], each curve uses unit-slope offset tails: `x + first.y` below black and `x + (last.y - 1)` above white. Identity endpoints therefore retain exterior samples; moved endpoints shift them continuously while retaining variation. The exterior boundary is not promised to have a continuous derivative. This is OpenLR behavior, not a claim about Adobe interpolation or HDR rendering.

## Persistence and verification

Copy, Paste, named versions, presets, local sidecars, synchronization and OpenLR XMP preserve the same recipe owner. The Curve category in Choose edits includes the three existing sliders and `toneCurves`; selective copying a missing owner resets it on the target. XMP, presets, sidecars, version/copy operations and sync validate supplied curves with the shared domain rule. Standard Adobe curve tags are not newly interpreted by this change.

A malformed local sidecar keeps its existing visible error and blocks edits to that photo. Its curve panel is disabled while the folder remains browsable, including Edited filtering; the invalid owner is treated as present rather than interpreted as a valid neutral curve. Original files and the invalid sidecar are not overwritten. Historical null local edit records retain the adapter's existing empty-recipe interpretation.

`tests/tone-curves.test.js` verifies domain validation, shape and identity, narrow valid intervals, channel order, signed/HDR samples, original immutability and legacy-stage preservation. `tests/tone-curves-workflow.test.js` verifies actual graph and keyboard interaction, saved state and history, exported pixels in both processing versions, transport through presets/versions/XMP/copy, reload and stale guards. Native smoke exercises the shared CLI, actual image output and workspace capture. Results and platform limitations belong in [acceptance](acceptance.md).
