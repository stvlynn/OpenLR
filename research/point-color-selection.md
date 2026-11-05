# Point-color selection ownership

## Display sampling follow-up (2026-11-06)

At `ce20ab4`, GUI point sampling read the clicked canvas before queueing `point-add`, whereas `sample-color` rendered the committed edited recipe at a maximum edge of 1280. Actual Chrome verified a generated 1536×32 sRGB PNG with red columns 303–304 against black: Linear at 100% zoom showed `[255,0,0,255]` at x=303.5, but the existing capped read returned `#bc0000`. The latter is the correct encoded half-linear-red interpolation at that reduced output location. Replacing the GUI read with that API would alter the visible-pixel interaction; changing `sample-color` would break its existing canonical edited-image contract. Neither change is needed.

The added `point-sample` command reads the mounted committed canvas and reuses the existing point-add operation. It requires the point eyedropper in Detail, validates normalized coordinates and an optional photo guard, and returns the same saved point record. Paint publication records the canvas, photo and committed edit identity. GUI dispatch supplies its actual clicked node through private request context; a superseded clicked canvas is rejected rather than silently sampling a different frame. Clipping-warning pixels and uncommitted adjustment previews are ineligible; the picker remains available for a valid retry. Explicit hex addition, canonical sample-color and original-coordinate neighborhood white balance retain their prior behavior. No second renderer or photo-edit rule is introduced.

Context7 `/mdn/content` confirmed that [`getImageData`](https://github.com/mdn/content/blob/main/files/en-us/web/api/canvasrenderingcontext2d/getimagedata/index.md) reads underlying canvas pixels independently of the context transformation matrix. The existing `sampleColor` owner maps normalized positions to that backing store and clamps inclusive endpoints to its last pixel. Browser pointer coordinates are normalized against the clicked element bounds, so the command does not invent another geometric transform.

The actual source/ownership comparison is:

| Path | Full-resolution visible red pixel | Previous canvas clicked during held edit save |
| --- | --- | --- |
| Prior GUI pre-read followed by unguarded point-add | `#ff0000` | Saved stale `#ff0000` after the edit |
| Existing canonical sample-color | `#bc0000` | Read-only edited-image API, not the GUI save operation |
| New shared display sampling | `#ff0000` via GUI and CLI | Rejected; only the intended Exposure edit remained |

The stale case holds the completion callback of the real thumbnail encoding, performs a trusted click on the still-mounted canvas, then releases the edit. After Exposure -1, the current canvas sample is `[188,0,0,255]`; accepting the old click would associate a color from the previous recipe with the new recipe. `tests/point-sampling.test.js` reproduces the old behavior and verifies the repaired path, selection, save/undo/redo/reload, original bytes, invalid requests and clipping refusal. Existing point/range/optics tests passed 9/9. A separate ignored `.workspace/point-video-probe.mjs/.log` generated VP9 video and sampled two paused edited frames at .25/.75 seconds: actual stage hex `#8c8c8c`/`#1c46f1` matched both saved point records, and playback stayed paused at the requested times. This is a bounded video observation, not coverage of every codec or playing-frame timing.

The earlier selection investigation follows; its scope and date remain unchanged.

Date: 2026-11-05. This is an OpenLR GUI/CLI interaction correction, not a reconstruction of Adobe's color algorithm.

## Evidence and product boundary

The [Lightroom evidence index](lightroom.md) records R3 resources `DEVELOPPOINTCOLORCONTROLLER.LUA` and `DEVELOPPOINTCOLOROVERLAY.LUA`, plus local sampling-related strings. They establish point-color tool identities, not the installed application's selection-state lifetime or its image-processing algorithm. No Adobe source, asset or implementation is reused here. No new installed-Lightroom point-selection runtime observation was made for this change.

OpenLR's [agent contract](../docs/agent-cli.md) requires controls and CLI to use the same command queue and expose live state. Its existing point dropdown privately refreshed sliders. At `41fba14`, application `selectedPoint` was only a one-render hint following `point-add`; the DOM retained the actual selected ID. Thus CLI `point-update` and `point-remove` correctly accepted explicit IDs, but the current GUI selection was neither observable nor controllable through the public commands.

An actual Chrome audit used a generated 80×60 PNG, added red point A and blue point B, and selected A through the dropdown. Full public state was deeply identical before and after that choice. A subsequent CLI update of B changed B while A remained shown; keyboard ArrowRight on Point hue changed A. A real eyedropper click created and selected a third sample, preserving A's color. Removing nonselected B also worked. This proves a selection-visibility/control gap, not missing color processing or broken explicit-ID edits. The ignored audit script and output are `.workspace/point-color-selection-audit.mjs` and `.json`.

## Primary-source checks

Context7 `/mdn/content` was resolved and queried for select value and committed change semantics. The returned [MDN source](https://github.com/mdn/content/blob/main/files/en-us/web/api/htmlselectelement/value/index.md) and [API documentation](https://developer.mozilla.org/en-US/docs/Web/API/HTMLSelectElement/value) establish that `select.value` reads or sets the selected option's value and returns an empty string when none is selected. MDN's [change event documentation](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/change_event) identifies a committed user choice as the event boundary. A render function can therefore set the displayed value from application state, while the change handler submits a command with the chosen ID.

The primary [React documentation source on state structure](https://github.com/reactjs/react.dev/blob/main/src/content/learn/choosing-the-state-structure.md) demonstrates storing a selected ID and deriving the item from the current collection, avoiding a duplicated selected object that becomes stale when the item changes. This is a state-design reference only: OpenLR remains dependency-free ES modules and does not import React or its sample code.

## Design alternatives

1. **Keep DOM-owned selection.** Existing behavior works for human editing but cannot satisfy public selection discovery or command control. Merely reading the DOM in `state` would leave selection mutations outside the central dispatcher and make a presentation node authoritative for agent behavior.
2. **Persist selection inside the photo recipe.** This would make navigation an edit and require writes/history for choosing a control target. It adds no image-processing meaning and conflicts with keeping view state separate from recipes.
3. **One active-photo session selection, rendered into the DOM.** Store only identity, derive the selected sample from the current recipe, and route dropdown changes through `point-select`. Associate the identity with the active photo because copied recipes may reuse point IDs. Reconcile invalid selection after removal, reset, undo or recipe replacement; choose the first remaining sample or empty when none remain. Adding a sample still selects the new one. This closes both directions of the gap without duplicating pixel processing or adding persisted state.

The third alternative fits the existing dispatcher architecture. Selection must leave recipes, original bytes and edit history unchanged. Optional `photoId` protects a queued selection against changing assets. Existing update/remove operations remain explicit-ID operations; selecting is not a new prerequisite, and eyedropper clicks continue to add samples rather than replace the selected sample.

## Executed old/new ablation

Windows, Node 24.9, installed Chrome through Playwright. Two isolated browser contexts imported the same generated 80×60 solid-color PNG and added red point A and blue point B. The baseline context served `app.js`, `point-color.js` and `agent-protocol.js` directly from commit `41fba14` using browser request routing; the candidate used the current shared-selection modules. All other files and the interaction sequence were the same. This compared actual application code, not a simulated selection reducer.

| Observed operation | DOM-owned baseline | Shared selection |
| --- | --- | --- |
| Choose A in the actual dropdown, then read full state | Entire state unchanged; no point-selection key | State changes and exposes `selectedPoint` |
| Recipe before/after choosing A | Unchanged | Unchanged |
| Submit `point-select` for B | Unknown command | Succeeds and actual dropdown shows B |

All assertions passed. Executed command: `node .workspace/point-selection-ablation.mjs`; ignored evidence output: `.workspace/point-selection-ablation.json`. The baseline failure is the expected missing operation, preserved as evidence rather than hidden by a test stub. These three comparisons justify central selection ownership for the stated interaction gap. They do not establish native transport, photo-switch race handling, persistence or processing quality; dedicated acceptance tests cover those separately.

## Verification scope

The final implementation requires actual browser checks of GUI selection reflected in full/summary state, command selection reflected in slider values, unchanged recipe/history on selection, removal/reset/undo/asset-switch reconciliation and stale-photo rejection. Native CLI transport must separately verify returned selection data and an actual workspace image. The state-design documentation and earlier audit do not by themselves prove that final behavior; results belong in the [acceptance record](../docs/acceptance.md).

## Straighten-to-point sampling transition

A follow-up actual Chrome 156.0.8078.80 audit activated `straighten-tool`, pressed the real **Sample color** button, and clicked the generated image. Public state reported `sampling:"point"`, but no sample was added. This also occurred after choosing the first straighten reference point. As a control, activating white-balance sampling first cleared the optics mode; the same point-color button and image click then added `#406080` and ended sampling. Source inspection found that the shared optics-deactivation list included `sample-tool` and `local-tool` but omitted `point-tool`. The stale optics mode consumed the stage click even though its pointer handlers were unmounted during sampling.

The regression repeats ordinary sampling and both straighten transitions with actual mouse clicks. Before the fix it failed a bounded three-second wait for an added sample after switching from straightening. The correction adds `point-tool` to the existing transition list; no second geometry or sampling path is introduced. Ignored audit evidence is `.workspace/gui-parity-next-audit.mjs` and `.json`; pre-fix test output is `.workspace/point-straighten-before.log`. Final test results are recorded in acceptance.
