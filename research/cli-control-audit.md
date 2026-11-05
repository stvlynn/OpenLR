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
