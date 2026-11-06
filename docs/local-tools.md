# Masks and local repairs

Color/luminance ranges, editable add/subtract/intersect groups, real depth range and depth-guided lens blur are documented in [range and depth tools](range-depth-tools.md). Local semantic subject/person/sky/background inference is documented in [AI masks](ai-masks.md).

Open **Masks & local repair** in the editor, choose a tool, and drag on the image. Linear gradients progress from zero at the first point to full strength at the second. Radial gradients begin at the center and fade to zero at the ellipse edge. Brush masks cover the continuous stroke, including the segments between pointer samples. **New masks start with zero adjustments and leave photo pixels unchanged.** Select a mask, inspect its actual red coverage overlay, then adjust exposure, contrast or saturation. Explicit CLI adjustment arguments still apply. Opacity, feather, inversion and enable/disable are edited in the inspector; the edit selector chooses an existing recipe, and Remove deletes it. Linear ramps have no separate feather control.

For **Clone**, Alt-click the source (or click Choose repair source, then the image), and drag the target stroke. The source-to-target offset remains fixed along that stroke. **Heal texture** samples the same source but matches its weighted mean RGB color to the destination before blending; this preserves source texture while reducing tonal seams. It is an original, deterministic mean-matching implementation, not generative removal, Poisson healing, or automatic object selection. Sources outside the image are skipped instead of smearing an edge. Sources outside the active crop still work.

The source picker, Alt-click and `repair-source` share the dispatcher. With Clone or Heal selected, `repair-source --point '{"x":0.25,"y":0.5}'` sets the source in normalized original-image coordinates; `--picking true` arms the image picker and `--picking false` cancels it. Point and picking are mutually exclusive. With no arguments the command reads `{point,picking}` without a change notification; full/summary state exposes the same object as `repairSource`. An optional `photoId` guards reads and changes. Selecting a source changes no saved recipe or undo entry; a later repair stroke captures that source in its committed recipe. Changing the source cancels an unfinished stroke. Escape (including while an inspector control is focused) or **Cancel source selection** exits the picker and retains the last source. Leaving/rebuilding the editing surface or changing tools exits picking; selecting another photo also clears the source. An open dialog retains its own Escape handling.

Recipes live in `photo.edit.localTools = {masks:[], repairs:[]}`. All points are normalized fractions of the decoded oriented original image, before crop, quarter-turn rotation, or reflection. Brush/repair radius is a fraction of the original short edge; radial x/y radii are fractions of original width/height. Display coordinates invert the exact crop/rotation/flip mapping. Repairs and new removal patches follow their recorded order on a derived source buffer, then masks run in list order, then the existing geometry/global processing pipeline executes. A repair uses a deferred destination patch so overlapping clone strokes sample immutable pre-stroke pixels. Processing visits the affected region for brush/radial/repair tools and the full frame for linear/inverted masks. Preview, thumbnails, and export share this implementation. Originals are unchanged.

All changes use the shared serialized application queue, persistence, and undo/redo. UI commands carry a selected-photo guard so a queued gesture cannot write to a newly selected photo. **Show overlay (O)** or the O shortcut toggles the selected mask's true soft coverage. All mask types use the same coverage renderer, including semantic, color/luminance, composite and depth masks. The overlay is temporary presentation state and is absent from image exports. CLI `mask-preview --id ID --style gray --output mask.png` exports grayscale coverage, and `--style rgba` exports red coverage with proportional alpha. Coverage follows optics, crop and aspect ratio, quarter-turn and reflection. Global color adjustments apply only to the photo.

**Remove masked area** and `remove-mask --id ID` consume a mask and save an inpainted patch using surrounding pixels. Coverage and the solver read the same retouched source before mask/global adjustments. A new removal follows existing Clone/Heal strokes; a new stroke drawn after that removal follows its patch. Earlier strokes remain editable, and updating a stroke retains its position. The mask and new patch are restored or removed together by undo/redo. Historical saved fills retain their original pre-red-eye/pre-repair position.

New patches use `edit.postRepairFills` and stable IDs; later repair recipes record an internal `afterFillId`. The dispatcher owns this ordering for GUI and CLI. Copying Content-aware removal includes historical and new patches. When copying repairs without their original patches, a missing anchor places the repair after the destination's current last patch, or with ordinary repairs when none exist. The next removal retains that actual placement. See [ordered removal](decisions/020-ordered-removal.md) for persistence and compatibility. The RGB solver and saved patch remain 8-bit sRGB; Linear keeps its precise coverage reference and only quantizes the selected patch. Soft patches use source-over and may increase alpha inside the selection; exterior samples remain intact.

Successful `repair.add` selects its new repair through the dispatcher before returning state or notifying observers, just like a GUI stroke. It preserves the current overlay visibility and tool mode. Mask creation retains its existing selected-mask/visible-overlay behavior. UI handlers do not apply a second selection after the command completes.

Escape discards the in-progress local stroke, even when an inspector control retains focus. `local-cancel` performs the same operation through the dispatcher and returns `{canceled:true}` only when a draft existed; an optional `photoId` guards the target. Cancellation preserves the selected tool and previously committed edits. Losing pointer capture, pointer cancellation, switching tools or rebuilding/leaving the editing surface also discard the draft and release its capture. A later pointer release cannot commit the canceled stroke. The next stroke remains usable and contributes one normal undo entry.

## CLI

The native GUI must be running for changes; `schema`, discovery and `--dry-run` are available offline. Existing format/order conventions are unchanged. Examples use JSON objects for nested recipes:

```powershell
node cli/openlr.mjs schema mask.add
node cli/openlr.mjs mask.add --args '{"mask":{"type":"linear","start":{"x":0.1,"y":0.2},"end":{"x":0.8,"y":0.2},"adjustments":{"Exposure":1}}}' --dry-run
node cli/openlr.mjs mask.add --args '{"mask":{"type":"radial","center":{"x":0.5,"y":0.5},"rx":0.2,"ry":0.3,"feather":0.6,"adjustments":{"Saturation":-50}}}'
node cli/openlr.mjs repair.add --args '{"repair":{"type":"clone","source":{"x":0.2,"y":0.3},"points":[{"x":0.7,"y":0.6},{"x":0.75,"y":0.6}],"radius":0.03,"feather":0.5}}'
node cli/openlr.mjs state
node cli/openlr.mjs mask.update --args '{"id":"ID from state","changes":{"invert":true,"adjustments":{"Exposure":0.5}}}'
node cli/openlr.mjs repair.remove --id 'ID from state'
```

`mask.add/update/remove` and `repair.add/update/remove` share nested validation with the GUI. IDs are generated on add; update/remove require an existing ID. Updates merge adjustment values without changing other local settings. An optional `photoId` rejects a request if selection has changed. There is no separate hidden CLI catalog.

To inspect a new stroke without adding it, activate the matching local tool and add `--draft true` to `mask.add` for Brush, Linear or Radial, or to `repair.add` for Clone or Heal. The geometry uses the same original-image coordinates as the saved form. Clone and Heal take the source point in their recipe. Full and summary `state` expose `localDraft` with its ID, photo, typed geometry, status and overlay visibility. The existing photo preview and exports continue to use the saved recipe.

```sh
node cli/openlr.mjs local-tool --tool radial
node cli/openlr.mjs mask.add --args '{"mask":{"type":"radial","center":{"x":0.5,"y":0.5},"rx":0.2,"ry":0.3},"draft":true}'
node cli/openlr.mjs preview --source local-draft --draftId ID --output overlay.png
node cli/openlr.mjs draft-commit --id ID
node cli/openlr.mjs draft-cancel --id ID
```

The PNG is the actual transparent overlay at its displayed dimensions. Masks show red coverage at the editor's overlay opacity, and repairs show the stroke path and source marker. A hidden mask overlay returns a transparent layer. For the photo and controls together, use `--capture` or `screenshot`. `mask-preview` continues to export coverage of a saved mask. A new draft supersedes the old ID. Commit adds one ordinary mask or repair with its normal history and selection behavior. Cancel clears the layer without saving, and `local-cancel` still discards the current local stroke. [Draft design and verification](../research/local-stroke-drafts.md)

The GUI **Local tool** selector runs the same `local-tool` command as the CLI. Selecting a tool opens Detail and exits crop, comparison and sampling before mounting its interaction surface. This changes presentation state, not the photo recipe; creating or changing a mask remains a separate command. Both full and summary `state` expose `localTool` as `off`, `brush`, `linear`, `radial`, `clone` or `heal`. It identifies the selected mode, which may remain selected while Grid is displayed; `mode` supplies that context. `localSelection` retains its existing mask/component/overlay contract. Tool changes notify live observers through the dispatcher.

## Sources and verification

The coordinate, mask rasterization, and texture-healing code is original OpenLR code. It uses the public Canvas `ImageData` API and ordinary weighted/premultiplied-alpha mixing; no Adobe source, assets, models, or published proprietary algorithm was copied. References: [WHATWG Canvas specification](https://html.spec.whatwg.org/multipage/canvas.html), [W3C compositing specification](https://www.w3.org/TR/compositing-1/). Earlier Lightroom investigation establishes only prior-art tool identities, not implementation equivalence.

Run `node --test tests/local-tools.test.js` with Chrome and a reachable local HTTP server. Validated on Windows/Chrome: masks change only covered pixels; inverse masks invert coverage; clone and mean-matched repair produce real pixel changes; coordinate round trips hold for crop × four quarter-turns × reflection; CLI rejects invalid nested points/values; a real UI brush gesture persists through reload and undo/redo; cloning from outside a crop remains correct after rotation/flip in an exported PNG. Native WebView gestures, very large/high-density brush paths and subpixel preview differences require additional platform coverage. Display remains 8-bit; [Linear processing](linear-working-frames.md) performs supported local operations on float samples and retains TIFF16 export precision.

Run `node --test tests/removal.test.js tests/float-mask-preview.test.js` to check both inpainting solvers, the decoded mask and photo geometry, and range coverage after red-eye in both processing versions. The generated red-patch case also checks unaffected pixels, undo and original bytes.

The `color-sample` local tool uses the same dispatcher activation contract and preserves the selected mask/component for range refinement. `range-color` reads the unedited decoder display source through original coordinates; the existing edited-view `sample-color` is unchanged. Details and precision limits are in [range tools](range-depth-tools.md#original-range-color-sampling).
