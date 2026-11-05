# Catalog organization evidence

## Expanded stack readback — 2026-11-06

The new native organization workflow reproduced a public-state inconsistency in OpenLR: ungrouping an expanded stack cleared the photos' membership while `state.openStacks` still exposed the former ID. A later similarity stack therefore returned an obsolete ID alongside the actual group. This is OpenLR runtime evidence, not an inference about Lightroom.

Three candidates were compared in Chrome 156 with the same current `tests/stacks.test.js` workflow, intercepting only the application's module response. The baseline module came from `0c030e5`; the direct-delete candidate added a successful-unstack cleanup to that module; the final candidate used the current projection. Production files were not temporarily reverted.

| Candidate | Ungrouped state | Undo restoring the stack | Result |
| --- | --- | --- | --- |
| Original session Set exposed directly | Still contains removed ID | Existing preference retained | Fails at empty-state assertion |
| Delete preference after successful unstack | Empty as required | Expanded preference lost | Fails at restored-state assertion |
| Project preferences through current catalog IDs | Empty as required | Expanded preference restored | Entire workflow passes, including filtering, redo and final-member purge |

The chosen implementation keeps session preferences and reports only IDs referenced by the full current catalog, independently of the visible search/filter subset. It changes no stored row, transaction or history rules. The ignored comparison harness/results are `.workspace/stack-state-ablation.test.mjs` and `.workspace/stack-state-{baseline,delete,projection}.log`. The tracked browser regression and `scripts/native-organization-smoke.mjs` verify the production behavior; [acceptance](../docs/acceptance.md) records exact execution and platform boundaries.

Reviewed 2026-11-05. This is a focused extension of the [Lightroom investigation](lightroom.md), using the installed Lightroom 9.4 resources and Adobe's desktop documentation. No Lightroom catalog, personal photos, executable payloads, or assets were copied into OpenLR.

## Static resource evidence

A new REA `inspect_pe_resources` call on `C:/Program Files/Adobe/Adobe Lightroom CC/lightroom.exe` returned Evidence `ev_b95ac8eed4d87f5fc5c661b7f17cc4e7542aa25688ca56288715da4b3ade96fc`. The EXE SHA-256 is `02d95f07c18e3c932117af590f7b074c6a0c5cab4db4b4b7e717ddbc0eae7cf1`, 27,316,208 bytes. Its complete resource inventory examined 507 entries and found 247 resources. Resource index 122 is `$LR$ORGANIZE$CONTROLLER.LUA`, payload offset 26,707,288, 2,706 bytes, SHA-256 `5f18e095bc2298435de1f0d36691f53a8bad4f21d64fc05a05cda7c5176cfd61`. That name establishes an organization-controller resource, not its executed behavior.

The existing retained ledger was empty when queried in this connection; the target-free PE inspection above recreated the same deterministic Evidence identity. No native binary session was opened and no target execution was requested.

The installed `Resources/zh_cn/TranslatedStrings.txt` was searched read-only. The source identity is recorded in [the original report](lightroom.md). Relevant keys and local line ranges:

| Concern | Resource evidence | Limit |
| --- | --- | --- |
| Group selection | `Application/Menu/Edit/SelectAll`, lines 2505–2506 | Menu identity, not measured modifier selection behavior |
| Copy and batch paste | `AgDevelop/Menu/Edit/CopySettings/Key`, `PasteSettings/Key`, `PasteSettingsAllSelected/Key`, lines 954–958 | Constants, not a traced edit transaction |
| Batch changes | `BatchEdit/ResetSettings`, `RestoringSettings`, rotation/flip names, lines 2714–2734 | Supports task vocabulary; no native transaction semantics recovered |
| Album rename | `CollectionsPanel/UndoText/RenameAlbum`, line 3859 | Resource identity only |
| Versions | `Organize/DeleteVersionConfirmation`, line 6968; `RestoreVersion`, line 7400; version Export/MakeNamed/Rename, lines 7475–7482 | Static labels and confirmation text; no automatic-version implementation recovered |

## Official desktop documentation

[Adobe's organization guide](https://helpx.adobe.com/lightroom/desktop/organize-photos/organize-photos.html) documents multiple-photo rating and flags, adding grid selections to albums, album rename/delete, minimum-rating and flag/edit-state filters, and sorting. These are documented workflows, rather than observations of the installed Windows runtime.

[Adobe's editing guide](https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html) describes copying settings from one image to multiple selected images, choosing settings groups, named and automatic versions, version rename/delete, and version-specific export. The page was updated 2026-10-18, so its current instructions may differ from the installed 9.4 build.

## OpenLR decisions and verification scope

OpenLR independently implements multi-selection, filtered-view selection boundaries, bulk metadata, recipe copy/paste, imported-library albums, and named versions. Its Ctrl/Shift selection rules, normalized recipe storage, sequential batch-failure reporting, catalog transaction for album removal, sidecar persistence, and session clipboard are implementation decisions. No Adobe code, pixel algorithm, or state storage format was recovered or reused.

OpenLR does not claim parity for automatic/cloud versions, smart albums, folders of albums, stacks, semantic search, or Lightroom's selection animation and exact visual layout. OpenLR's behavior is verified through its own browser and native tests, separately from the static Lightroom observations.

## Current workflow audit and independent decisions

A later 2026-11-05 audit reissued the target-free REA PE inventory after the connection no longer retained the earlier record, reproducing its deterministic identity. The installed menu bytecode again exposes distinct export and previous-export commands; the existing Windows runtime table remains separate evidence. No new claim about Adobe undo transactions is inferred from those resources.

Two actual OpenLR browser regressions changed the implementation decision. Saving an Unedited filter as a smart album omitted a neutral `processVersion:2` photo even though the ordinary view included it. `smartMatch` had duplicated a truthy-edit test instead of using the catalog filter owner. Both paths now share the same predicate and persisted rule shape. Creating and reopening smart albums exercises the actual GUI and shared commands, not just synthetic rule objects.

In a second browser sequence, a source photo had Exposure 1 and rating 5, then its settings were pasted to a target in Grid. Ctrl-Z reset the earlier source rating to 0 and left the target Exposure 1: the shortcut unconditionally chose library history, while Paste recorded photo history. Routing every Grid undo to photo history instead would lose ordinary rating/album undo. The selected approach orders the existing records with a shared session counter and chooses the latest applicable library/active-photo record. It keeps explicit history commands and per-photo paste semantics, with no duplicated catalog snapshots and no wall-clock ordering ambiguity. This is an OpenLR interaction decision, not recovered Adobe behavior.

Context7 `/darktable-org/darktable` was consulted for [module history replay](https://github.com/darktable-org/darktable/blob/master/dev-doc/Module_Lifecycle.md) and the [agent history/export contract](https://github.com/darktable-org/darktable/blob/master/src/mcp/README.md). Those sources distinguish per-image processing history from catalog metadata and route replay through the existing processing engine; they do not prescribe OpenLR's shortcut scope. No upstream implementation was copied. Export audit also confirmed that OpenLR's previous-settings shortcut already exists, but its settings reuse is not yet a discoverable CLI command; metadata and output sharpening are separate remaining export work, not part of this catalog correction.

The old view-only route and the new session-order route were compared on the same generated-photo sequence: the old path changed rating 5→0 while leaving pasted Exposure 1; the new path leaves rating 5 and restores the target recipe. Three real-browser history tests pass, including alternating undo/redo and changing the active photo. The proposed always-photo alternative is rejected by its inability to reach library actions; that statement is source-level reasoning, not an additional measured UI experiment. Smart-album tests cover both the shared predicate and actual saved/reloaded GUI albums. Full native/platform results belong to the corresponding acceptance run.

## Shared previous-export workflow

The follow-up export audit used the same REA inventory and independently read the installed `$NIMBUS$MENUS.LUA` payload at offset 26,741,832, length 18,861 (resource index 128). `research/menu-bytecode.mjs` resolves distinct menu command constants `ag.file.export` and `ag.file.exportPreviousSettings` at PCs 112–113. The earlier Windows runtime observations in [Lightroom evidence](lightroom.md) confirm the menu and shortcut. Neither establishes how Adobe commits settings, separates media types, or handles a failed save.

Context7's Darktable agent documentation was consulted for explicit export output paths and configuration. OpenLR already had a working GUI shortcut and shared format/color capabilities. The actual gap was CLI discovery and a shared completion contract, not a missing renderer. [The decision](../docs/decisions/012-export-completion.md) keeps one export pipeline, captures effective options with output bytes, and remembers them only when the owning output adapter completes. Photo/video slots and legacy preference handling are explicit OpenLR choices. No upstream source, proprietary resource payload or personal image is distributed.

The save-policy ablation ran actual Chrome 155 GUI events and PNG rendering with injected native save boundaries. Initial settings were PNG/sRGB/80px, attempted settings PNG/Display P3/48px plus a watermark. Production completion-based remembering retained the initial settings after both cancel and write failure. The temporary encode-completion variant replaced them in both cases despite neither saving a file. Both failed-write variants delivered the same 924-byte valid PNG before `Begin → Write → Cancel`; four scenario assertions passed. The early variant only inserts a settings write at BeginExport entry, after real encoding, without changing production source. An initial probe read too early; the final probe explicitly waits for the asynchronous hook to finish. Reproduce with `node research/export-completion-ablation.mjs`; generated results and screenshots go to ignored `.workspace/export-previous-ablation/`.

Final 1280px and minimum-width 1024px browser screenshots were visually inspected. A long button initially wrapped and crowded the fixed-height toolbar. The compact **Export again** label retains the complete accessible description, and the search field now shrinks while toolbar buttons stay single-line. This was a layout correction, not an additional export workflow. Native OS chooser interaction remains outside the simulated save-boundary experiment.
