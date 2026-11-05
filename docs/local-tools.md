# Masks and local repairs

Color/luminance ranges, editable add/subtract/intersect groups, real depth range and depth-guided lens blur are documented in [range and depth tools](range-depth-tools.md). Local semantic subject/person/sky/background inference is documented in [AI masks](ai-masks.md).

Open **Masks & local repair** in the editor, choose a tool, and drag on the image. Linear gradients progress from zero at the first point to full strength at the second. Radial gradients begin at the center and fade to zero at the ellipse edge. Brush masks cover the continuous stroke, including the segments between pointer samples. **New masks start with zero adjustments and leave photo pixels unchanged.** Select a mask, inspect its actual red coverage overlay, then adjust exposure, contrast or saturation. Explicit CLI adjustment arguments still apply. Opacity, feather, inversion and enable/disable are edited in the inspector; the edit selector chooses an existing recipe, and Remove deletes it. Linear ramps have no separate feather control.

For **Clone**, Alt-click the source (or click Choose repair source, then the image), and drag the target stroke. The source-to-target offset remains fixed along that stroke. **Heal texture** samples the same source but matches its weighted mean RGB color to the destination before blending; this preserves source texture while reducing tonal seams. It is an original, deterministic mean-matching implementation, not generative removal, Poisson healing, or automatic object selection. Sources outside the image are skipped instead of smearing an edge. Sources outside the active crop still work.

Recipes live in `photo.edit.localTools = {masks:[], repairs:[]}`. All points are normalized fractions of the decoded oriented original image, before crop, quarter-turn rotation, or reflection. Brush/repair radius is a fraction of the original short edge; radial x/y radii are fractions of original width/height. Display coordinates invert the exact crop/rotation/flip mapping. Repairs run in list order on a derived source buffer, then masks run in list order, then the existing geometry/global processing pipeline executes. A repair uses a deferred destination patch so overlapping clone strokes sample immutable pre-stroke pixels. Processing visits the affected region for brush/radial/repair tools and the full frame for linear/inverted masks. Preview, thumbnails, and export share this implementation. Originals are unchanged.

All changes use the shared serialized application queue, persistence, and undo/redo. UI commands carry a selected-photo guard so a queued gesture cannot write to a newly selected photo. **Show overlay (O)** or the O shortcut toggles the selected mask's true soft coverage. All mask types use the same coverage renderer, including semantic, color/luminance, composite and depth masks, mapped through original coordinates, optics, crop and rotation. The overlay is temporary presentation state and is absent from image exports. CLI `mask-preview --id ID --style gray --output mask.png` exports actual grayscale coverage; `--style rgba` exports a red coverage PNG with proportional alpha. It applies geometry/optics without global color adjustments.

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

The GUI **Local tool** selector runs the same `local-tool` command as the CLI. Selecting a tool opens Detail and exits crop, comparison and sampling before mounting its interaction surface. This changes presentation state, not the photo recipe; creating or changing a mask remains a separate command. Both full and summary `state` expose `localTool` as `off`, `brush`, `linear`, `radial`, `clone` or `heal`. It identifies the selected mode, which may remain selected while Grid is displayed; `mode` supplies that context. `localSelection` retains its existing mask/component/overlay contract. Tool changes notify live observers through the dispatcher.

## Sources and verification

The coordinate, mask rasterization, and texture-healing code is original OpenLR code. It uses the public Canvas `ImageData` API and ordinary weighted/premultiplied-alpha mixing; no Adobe source, assets, models, or published proprietary algorithm was copied. References: [WHATWG Canvas specification](https://html.spec.whatwg.org/multipage/canvas.html), [W3C compositing specification](https://www.w3.org/TR/compositing-1/). Earlier Lightroom investigation establishes only prior-art tool identities, not implementation equivalence.

Run `node --test tests/local-tools.test.js` with Chrome and a reachable local HTTP server. Validated on Windows/Chrome: masks change only covered pixels; inverse masks invert coverage; clone and mean-matched repair produce real pixel changes; coordinate round trips hold for crop × four quarter-turns × reflection; CLI rejects invalid nested points/values; a real UI brush gesture persists through reload and undo/redo; cloning from outside a crop remains correct after rotation/flip in an exported PNG. Native WebView gestures, very large/high-density brush paths and subpixel preview differences require additional platform coverage. Display remains 8-bit; [Linear processing](linear-working-frames.md) performs supported local operations on float samples and retains TIFF16 export precision.
