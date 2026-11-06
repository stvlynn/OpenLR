# Tonal color grading

Color grading provides Shadows, Midtones, Highlights and Global hue/saturation wheels with separate luminance controls. The three-wheel view shows the tonal regions together; choose a region or Global for a larger wheel. Numeric fields provide exact values. Wheel Left/Right changes hue; Up/Down changes saturation; Shift increases the step and Home centers saturation while retaining hue. Each wheel has a reset; Reset grading restores all defaults.

Dragging a wheel or luminance/balance/blending slider previews the current photo without saving intermediate recipes. Release commits one undoable edit. Escape, closing the panel, a source/edit change or a view-mode change cancels the gesture. Numeric changes and keyboard wheel steps use the same dispatcher. A focused numeric draft survives redraws for the same photo and view. Escape, closing the panel, hiding the inspector, switching photos, or changing the grading view discards it. On commit, the dispatcher checks the field value from when typing began, including any earlier numeric commit still in the queue for that field. Edits to independent fields can finish in sequence without invalidating each other.

## Recipe and commands

`grading-set --draft true` stages the same uncommitted photo preview as the wheels and sliders. The shared [adjustment draft contract](agent-cli.md#adjustment-drafts) provides state, exact displayed PNG, cancellation and a single undoable commit. The ordinary command continues to save immediately.

`colorGrading` is one optional recipe owner. Its optional `shadows`, `midtones`, `highlights` and `global` wheels contain hue [0,360], saturation [0,100] and luminance [-100,100], all defaulting to zero. Hue 360 canonicalizes to zero. Shared balance [-100,100] defaults to zero and blending [0,100] defaults to 50. Unknown fields, malformed objects and nonfinite/out-of-range numbers fail visibly. Full defaults remove the owner. Dormant hue and shared choices remain editable; without any nonzero saturation or luminance they do not mark a photo Edited.

`grading-mode --mode three` chooses the view; other modes are `shadows`, `midtones`, `highlights` and `global`. Full and summary state expose `colorGrading:{mode}`. `grading-set --value '{"shadows":{"hue":220,"saturation":25},"highlights":{"hue":40,"saturation":15}}'` replaces the complete owner, filling unspecified settings with defaults. An empty object resets it. Optional `photoId` and `expectedValue` guard the selection and previous canonical grading. GUI, browser automation and CLI share these commands.

Use `grading-set --photoId <id> --patch '{"field":"shadows.hue","value":220,"expectedValue":0}'` to update one field. The patch requires a photo ID and the expected numeric value. Paths are `balance`, `blending`, and `<wheel>.<field>` for wheel fields. The queue compares the expected canonical value with the current field, then applies the patch to the latest recipe. A patch is mutually exclusive with the full replacement arguments. Numeric inputs use this form so edits to independent fields can compose. Wheel gestures, keyboard wheel steps and resets keep the full-grading guard.

Copy edits offers one Color grading category. Presets, named versions, copied recipes, XMP, local sidecars and sync use existing recipe storage and the same validator. Local malformed sidecars remain visibly blocked and cannot be overwritten by editing. Undo and redo retain the existing session scope. Originals are never modified.

## Processing contract

The shared independent operator runs after curves and HSL/point color and before spatial effects. Regional weights derive from incoming linear sRGB luminance, a balance-dependent pivot and a normalized smooth partition. Increasing balance favors highlights; increasing blending broadens overlap. Global is independent of regional weights. Tint directions use the displayed sRGB hue definition, decoded to linear RGB and centered to zero Rec.709 luminance. All wheels read the same stage input; they do not sequentially tint one another.

Luminance is exposure-like: a wheel value of 50 represents one stop at full influence. Regional and global contributions combine, up to four stops overall. Exact black stays black. Chroma-only processing preserves linear luminance within floating-point error before output gamut conversion; it does not promise constant perceived brightness or perceptually uniform hue strength. Linear samples remain signed and unclipped; display/export quantization can clip out-of-gamut colors. Original processing decodes current bytes through the same operator and quantizes once afterward. Absent or neutral grading leaves existing output unchanged and alpha is preserved.

The complete equations, measured alternative comparisons and source boundaries are in [research](../research/color-grading.md); [decision 018](decisions/018-color-grading.md) records the implementation choice. This is not Adobe rendering equivalence.

## Verification

Run `node --test tests/color-grading.test.js tests/color-grading-input.test.js tests/color-grading-workflow.test.js tests/tone-curves-transport.test.js`, then `npm test` and the native suite for each target platform. Actual environment results and limitations belong to [acceptance](acceptance.md).
