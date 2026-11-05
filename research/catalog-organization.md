# Catalog organization evidence

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
