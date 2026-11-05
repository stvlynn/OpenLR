# GUI and CLI control audit

Reviewed 2026-11-05 against `f984692` before the viewport addition. This is a source-driven coverage audit in progress, not a declaration that all controls or Lightroom behaviors are equivalent. The user requires agents to operate the actual GUI through the shared dispatcher and receive current data/images.

## Evidence inspected

- `web/app.js`: primary handlers, keyboard dispatch, snapshot/summary state and serialized `run`/`execute`.
- `web/agent-protocol.js`: discoverable schemas and validation; `cli/openlr.mjs`: offline discovery, live transport and captured results.
- `web/preferences.js`: checkbox changes dispatch `preferences`; modal opening itself is presentation.
- `web/style.css`: the detail stage uses native overflow scrolling; full-resolution zoom removes canvas size constraints.
- Existing CLI/browser/native tests prove their asserted workflows, not every unenumerated handler. Continued work must inspect feature modules and dynamic command mapping, not count schema entries as complete coverage.

A local literal-call inventory after the addition found 153 schemas and 135 candidate `act`/`run` call sites across top-level web modules. Manual inspection removed a SQLite `db.run` call and the partial dynamic expression `run('merge-' + kind.value, args)`: 133 literal sites referred to 95 declared commands. The dynamic merge dispatch is covered by its two schema entries, but this inventory does not exhaust other aliases or parameter-dependent paths. The ignored `.workspace/cli-control-inventory.json` retains locations. This is search evidence, not a test or a completeness percentage.

## Confirmed viewport gap and resolution

The existing `zoom` command toggled fit/full resolution and state exposed its boolean. However, no command read or moved the detail scrollport, and neither full nor summary state reported its offset. A human could inspect other parts of a zoomed photo using native scrollbars while an agent could not request or verify the same view. Whole-image `preview` does not resolve that gap.

The added `viewport` command reads or sets absolute CSS-pixel offsets through the central dispatcher and the existing DOM scrollport. Both native scrollbar interaction and the command use the browser's one scroll state; no second pan model, transform or persisted recipe is introduced. The adapter reports actual offsets/dimensions and clamps to current extents. Full/summary state includes that snapshot; native scroll events notify the existing observation channel. Optional photo identity rejects a stale requested target before changing scroll position. Read-only calls neither scroll nor notify.

Primary API evidence: [Element.scrollLeft](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollLeft) exposes actual offsets including fractional CSS pixels; [Element.scrollTo](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollTo) supports explicit coordinates and instant behavior. Those semantics justify a DOM adapter, not claims about cross-platform execution. The browser/native tests must establish actual implementation behavior.

Context7 `/mdn/content` additionally confirmed `scrollWidth` and `clientWidth` include padding but exclude the vertical scrollbar, supporting the difference used for horizontal extent. It also records Safari overscroll behavior: reads report the actual DOM offset rather than inventing clamped observations, while explicit moves are bounded. OpenLR currently uses a left-to-right stage; this is not a generalized RTL scrolling adapter. macOS behavior still requires native acceptance.

The first Chrome acceptance checks discovery and dry-run typing, nonnegative validation, actual zoomed offsets, omitted-axis retention, bounds clamping, stale-target refusal, state readback, mouse-wheel changes and notification, unchanged recipe, fit bounds and Grid rejection. Native acceptance additionally checks actual CLI transport, PNG capture and original bytes. Test commands and measured platform outcomes belong in [acceptance](../docs/acceptance.md).

## Remaining audit scope

Inspect feature-module handlers for catalog organization, local/semantic masks, crop/optics, point/curve/grading selection, merge/enhance, export, sync, migration, external editors, camera and sharing. For each, distinguish semantic commands from file-picker acquisition, modal drafts and ordinary focus/scroll presentation. Verify representative GUI and CLI results against persisted state and actual images. A list of command names or an available screenshot endpoint alone does not prove these paths. Current platform/physical-device limits remain in the owning contracts and [completion audit](completion-audit.md).

## Feature-module dispatch inspection

Subsequent source inspection against `7a26649` traced these handler families. Test files listed here identify existing behavioral evidence; they are not claims that every listed workflow was re-executed during this source inspection. The last full run at that revision was 310/310; current changes and targeted runs are recorded separately in acceptance.

| GUI owner | Dispatcher mapping inspected | Observable evidence / boundary |
| --- | --- | --- |
| `organization-ui.js`, `copy-options-ui.js` | selection, filter, sort, album rename/delete/rule, version save/restore/rename/delete, copy/paste | Selection/filter/clipboard/version recipes in state; history, smart-rule and selective-copy browser tests. Dialog draft text is not a separate committed catalog. |
| `local-tools-ui.js` | `ai-mask`, dynamic `mask.add/update`, `repair.add/update`, `mask.component-update`, combine, local selection/tool, range sampling, depth and overlay | `localSelection` includes component path and overlay; range-mask/sampling and AI tests assert actual selection, coverage, pixels and persisted recipes. Mode/brush drafts require further full gesture audit. |
| `optics-ui.js` | optics update/reset, lens match/apply, straighten tool and point pair | Optics workflow verifies shared original coordinates, XMP and actual geometric results; profile boundaries remain explicit. |
| `tone-curves-ui.js`, `color-grading-ui.js` | curve channel/select/set and grading mode/set | Shared transient preview adapters; tests assert drag pixels, commit/cancel, source guards, export and persisted round trips. |
| `merge-ui.js`, `enhance-ui.js` | dynamic HDR/panorama merge, radiance export, enhancement | Generated registration/radiance and actual WASM/model output tests. Modal parameter collection is not another renderer. |
| `migration-ui.js` | scan, explicit source mapping, inspect/report, commit, native folder acquisition | Synthetic schema workflow and native migration test; genuine full catalogs remain unverified. File acquisition precedes the shared operation. |
| `external.js` | editor choice, external edit, explicit/automatic check | Native test launches an actual process, observes saved TIFFs and verifies imported derived pixels/originals; third-party proprietary editor compatibility is not implied. |
| `camera.js` | aliases through `dispatch`: tether, camera list/capture | Structured devices and imported files; native simulator only. Closing a modal does not capture a photo. |
| `sync.js` | `sync` with GUI-collected arguments | Structured conflict results and portable originals; browser convergence plus native loopback WebDAV evidence. |
| `sharing.js` | button helper dispatches configure/publish/reviews/revoke | Same server-backed review object returned to CLI; native loopback review service tests actual publication, browser comment/like and revocation. Presentation defect below was fixed. |

## Review presentation defect

`sharing.reviews` previously displayed `JSON.stringify(result)` in the navigation panel. That exposed internal photo/comment/reviewer identifiers and protocol keys to a user trying to read feedback, contrary to the requested interface clarity. It now presents photo names, reviewer names, comment text, localized timestamps and like counts, without changing CLI result fields or server storage. Empty/revoked states are explicit. Unmatched historical photo IDs are labeled as unavailable photos instead of exposing IDs. Text uses DOM `textContent`, including comments that resemble HTML; no review markup is executed. The existing narrow navigation column wraps content and configuration inputs.

The new real-Chrome dispatcher test uses a clearly injected native boundary to verify structured return preservation, human-readable grouping, hidden internal IDs, inert HTML-like text, timestamps, empty/revoked results and no horizontal overflow. The 1024×768 screenshot was visually inspected after scrolling feedback into view. Native service acceptance remains a separate actual-server check. This fixes a presentation issue found during audit; it does not close the remaining complete gesture/command inventory or final delivery audit.

## Straighten session follow-up

Inspection after public Actions acceptance found that `straighten-tool` could activate a GUI picker but exposed neither its pending first point in state nor an explicit cancel argument. Escape with an inspector input focused was ignored by the generic keyboard filter. The new Chrome test initially failed because `state.straightenTool` was absent. Context7 `/mdn/content` confirmed that [keydown targets the focused element and bubbles to Document](https://github.com/mdn/content/blob/main/files/en-us/web/api/element/keydown_event/index.md); this is API evidence, not an Adobe runtime claim. The existing command now accepts `off` and a photo guard, and Escape/the same guide button dispatch that command. Full/summary state reads one UI-owned point snapshot, with the existing change event after the first click. No second geometry implementation or new rendering algorithm is introduced. Browser verification exercises actual points, focused-input Escape, GUI/CLI cancellation, stale-target refusal, view exit, a subsequent successful straighten and undo. Native transport verification covers mode readback/cancellation and capture; it does not claim native mouse-gesture coverage.

## Repair source session

### Creation completion parity

An independent source review at `a05a501` narrowed a suspected add-selection gap to `repair.add`: mask creation already selected through the dispatcher, while repair creation selected only in the GUI promise continuation. A real-Chrome regression returned an empty `localSelection.id` after direct `repair.add`; after moving selection into the dispatcher, it reached and reproduced a second discrepancy, direct `ai-mask` leaving Brush active where the GUI alone switched Off. The fix retains the existing GUI completion behavior in the shared owner: repairs select without changing overlay visibility, and successful AI generation finishes drawing before selecting its mask, retaining panel openness and updating the cursor. GUI post-command selection/mode mutations were removed. No inference, mask rasterization or repair algorithm changed. The regression compares actual dropdown values at synchronous change notification, returned state, a real drawn repair, and GUI/direct bundled Person inference. This is observed OpenLR parity evidence, not a Lightroom runtime claim.

Inspection after `4dc31a6` found a remaining direct UI mutation: the Choose repair source button and Alt-click changed private `picking`/`source` variables without a dispatcher command or observable state. The initial real-Chrome regression failed with `Unknown command: repair-source`. Existing repair recipes already accept explicit source points, so this gap concerns the live GUI session rather than image processing. The existing source owner now supplies a shared `repair-source` read/update operation, full/summary state and ordinary change notifications. No new repair algorithm or second source model was introduced. The same focused-keyboard event evidence used for the straighten session applies; Escape cancels picking before the generic input-focus filter. Browser coverage checks actual Alt-click source capture, GUI/CLI cancellation, stale/invalid requests, read-only observation, subsequent clone recipe and red destination pixels, undo and photo/view cleanup. Native transport checks state, guard, capture and unchanged recipe; it is not a native pointer simulation.

## Local stroke cancellation audit

Source inspection after `b9d4849` found that local tools handled `pointercancel` but not lost capture or Escape, and unmount removed listeners without clearing the shared draft. A real Chrome reproduction left the stroke coverage overlay after Escape and remount; it did not prove an erroneous persisted edit, so that stronger claim is not made. The first test's path selector was corrected to the actual SVG image coverage before recording the reproduction.

Context7 `/mdn/content` confirmed the [pointer capture lifecycle](https://github.com/mdn/content/blob/main/files/en-us/web/api/pointer_events/index.md) and [lostpointercapture event](https://github.com/mdn/content/blob/main/files/en-us/web/api/element/lostpointercapture_event/index.md). Capture is implicitly released after pointerup/cancel; explicit cancellation should release owned capture and clear the gesture. This is browser API evidence, not a Lightroom runtime observation. No competing image algorithm or new renderer is needed.

The existing UI adapter now owns one cancellation function for draft/capture cleanup, used by unmount, tool changes and pointer events. Escape invokes the discoverable `local-cancel` dispatcher command, including while an inspector input retains focus. A stale photo guard rejects before cancellation. Real mouse tests cover brush, both gradients, clone and heal, explicit CLI cancellation, real capture release, injected pointercancel, view/tool/panel changes, unchanged recipes and subsequent successful drawing/undo. Native smoke verifies the actual command transport and idle result; it is not native pointer-gesture evidence. Exact execution results remain in acceptance.
