# Confirmation target ownership

Date: 2026-11-05. This is an OpenLR interaction correction based on its own runtime and shared-command contract, not an assertion about Adobe internals.

## Authority and primary API facts

The [agent contract](../docs/agent-cli.md) exposes one live state to controls and CLI. The [catalog contract](../docs/catalog-organization.md) distinguishes selected photo groups from explicit album identities; the [architecture conventions](../docs/template-conventions.md) require asynchronous work to retain its intended target. An existing modal does not suspend the CLI or make later selection the user's original confirmation target.

Context7 resolved `/mdn/content` and returned primary [dialog documentation source](https://github.com/mdn/content/blob/main/files/en-us/web/html/reference/elements/dialog/index.md), [returnValue source](https://github.com/mdn/content/blob/main/files/en-us/web/api/htmldialogelement/returnvalue/index.md) and [close source](https://github.com/mdn/content/blob/main/files/en-us/web/api/htmldialogelement/close/index.md). MDN's [showModal documentation](https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/showModal) describes modal top-layer presentation and inert controls outside the dialog. Its [returnValue documentation](https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/returnValue) and [close event](https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/close_event) describe the result string and close notification. Inference for OpenLR: these APIs report the user's closing action, not the application record IDs that action should affect. Those IDs must be captured and validated by the application.

## Executed baseline failure

Actual Windows Chrome **156.0.8078.80**, baseline `89d30d9`, isolated browser catalog, three generated photos A/B/C. The audit marked the photos deleted, selected A and opened the real permanent-delete dialog. While it remained open, a normal shared `select` command selected B. Clicking the actual confirmation button permanently removed B and left A. Reloading the deleted-photo view confirmed B remained absent and A remained present; no notice was shown. No I/O delay, queue replacement, synthetic close event, force click or persistence hook was used.

The audit also reopened the dialog and pressed Escape. A remained intact. Existing return-value clearing already prevents that cancellation from reusing a previous confirmation; a second cancellation mechanism is not justified by the evidence. Reproduction and observed results are retained in ignored `.workspace/purge-target-audit.mjs` and `.json`.

At the baseline, `purge` derives targets from the current selected group when execution starts. Its existing transaction deletes selected catalog rows and only unreferenced original media. The GUI opens a dialog without capturing the group, then calls unguarded `purge` at close. The transaction is not the defect: the wrong target is chosen before it begins.

A second executed purge audit kept A active but expanded selection to A+C while the dialog was open. Confirmation deleted both. Thus an active-photo ID check alone cannot protect a multi-photo confirmation: the expected group must match. Evidence is `.workspace/purge-group-target-audit.mjs` and `.json`.

Actual album runtime checks opened Rename on Album A, verified the prefilled name and typed a new name, then switched scope to B through the shared dispatcher before pressing Save. B was renamed and A was unchanged. Opening Delete on A, switching scope to B and pressing Delete then removed B; reload retained only A. Both cases used actual modal buttons and ordinary commands without injected waits or hooks. Evidence is `.workspace/album-dialog-target-audit.mjs` and `.json`. Source inspection explains the failures: the pending callbacks read mutable `current.scope` at close, although both underlying commands already accept an explicit album ID.

## Alternatives and design

- Resolving current selection at confirmation preserves the demonstrated wrong-target failure.
- Blocking all shared commands while any dialog is open would change the agent contract and unrelated workflows. It would not establish which original target was confirmed.
- Adding another confirmation, checksum or stored revision does not bind the existing confirmation to its original target.
- Capture the permanent-delete group when opening the existing dialog, then submit optional `expectedIds` to the existing `purge` command. Validate exact membership inside the serialized dispatcher, before its transaction. Order is irrelevant; a changed, expanded or reduced group must reject without deleting either group. Omitting the option preserves the existing CLI operation on execution-time selection. Current deleted-library and original-reference rules remain in force.
- Capture the explicit album ID when opening rename/delete. Dispatch the existing ID-based command with that identity after acceptance. Navigating to another album must not redirect the operation; if the original album was removed, existing command validation should reject. No second album mutation implementation is needed.

These differences reflect existing command contracts: purge operates on the current selected group, while album mutations explicitly name their target. The proposed guard does not create a mandatory CLI approval ritual or change permanent deletion's storage behavior.

## Verification scope

Final acceptance must distinguish observed baseline failures from fixed-code results. Test real confirmation buttons and Escape/cancel, CLI-driven selection/scope changes while the modal is open, group expansion/reduction, unchanged-target success, persisted results after reload, and shared-original retention for virtual copies. Guard rejection must precede any catalog write. Native CLI guard and actual screenshot results are separate from browser modal interaction evidence. Final results belong in [acceptance](../docs/acceptance.md).
