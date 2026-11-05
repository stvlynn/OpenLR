# Asynchronous XMP edit targets

Date: 2026-11-05. Scope: OpenLR's existing single-photo XMP application workflow. This is an asset/revision association correction, not a new Adobe compatibility claim.

## Authority and API facts

Project guidance requires asynchronous work to retain the intended asset and edit revision, and requires GUI, browser automation and CLI to use the central dispatcher. The [agent contract](../docs/agent-cli.md) already documents optional `photoId` guards for selected-photo operations. No installed-Lightroom behavior or proprietary algorithm is needed to establish this OpenLR invariant; existing REA observations are not evidence of its asynchronous implementation.

Context7 resolved `/mdn/content` and returned the primary [Blob.text source](https://github.com/mdn/content/blob/main/files/en-us/web/api/blob/text/index.md) and [await source](https://github.com/mdn/content/blob/main/files/en-us/web/javascript/reference/operators/await/index.md). The corresponding [Blob.text API page](https://developer.mozilla.org/en-US/docs/Web/API/Blob/text) states that text readback returns a promise resolving to UTF-8 contents. The [await reference](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await) establishes that awaiting pauses the surrounding async function, not the entire application. Inference for this handler: unrelated selection or edit commands can execute while file text is pending; serializing a command only after readback does not serialize the earlier file-selection intent.

## Current source and reproduced defect

At `509abb5`, the XMP file-input handler reads `file.text()` before calling `act('apply-xmp', {xml})`. The `apply-xmp` command has no asset guard and resolves the active photo when its queued execution starts. Other operations, including enhancement, already compare captured edit object identity against the current recipe to reject incompatible asynchronous results. Recipes are replaced through the existing persistence path, so object identity is an available session revision token; it need not be serialized or stored as new photo metadata.

Actual Windows Chrome **156.0.8078.80** audit used two generated 80×60 PNGs, A and B. A valid XMP was exported from A at Exposure +1, then A was reset. The actual XMP file input received that file. To make the timing deterministic, the test delayed `File.prototype.text` only for its generated filename, then called the original text reader after a controlled gate. While that read was pending, the normal shared selection command selected B. Releasing the gate caused B to become `{Exposure:1}` while A remained unchanged; no visible notice was produced. The production queue and persistence were not replaced or paused. This is a real handler/dispatcher/state result under an explicitly injected slow-I/O schedule, not a measurement of ordinary local-disk timing.

The executed audit and JSON are retained in ignored `.workspace/xmp-stale-asset-audit.mjs` and `.json`. It intentionally asserted the old incorrect result. A second executed browser audit routed the application and schema modules from exact commit `509abb5`. With A still selected and the generated file read pending, it applied Contrast +10 through the normal command and confirmed that edit. Releasing readback replaced the recipe with `{Exposure:1}`, discarding Contrast while B stayed unchanged and no notice appeared. Evidence is `.workspace/xmp-stale-revision-audit.mjs` and `.json`. This independently establishes why asset identity alone is insufficient. Final fixed-code acceptance remains separate from these intentionally reproduced old failures.

## Alternatives and bounded design

- **Read then resolve the active photo:** current behavior loses the original intent, as the executed audit demonstrates.
- **Automatically bind every command at `run()` submission:** unsuitable as a blanket rule. Library and batch commands have different targets, and scripts may deliberately queue selection followed by an unguarded active-photo command. This would alter existing CLI execution-time semantics beyond the evidenced defect.
- **Capture XMP asset identity before readback and validate in the dispatcher:** preserves the intended target without changing the queue or command ownership. Add optional public `photoId` to `apply-xmp`; the GUI supplies it. Omitting it preserves ordinary CLI active-photo behavior.
- **Capture only the asset ID:** prevents applying A's file to B but cannot detect edits changed on A while its file read is pending. The GUI should also capture the existing edit reference before readback and pass it through the existing internal command context. Validate that reference during serialized `apply-xmp` execution, before parsing/persistence/history changes. A check only immediately after readback leaves a second gap if another edit is already ahead in the queue.

Use the explicit asset guard and GUI-only expected-edit context together. Reuse existing object replacement semantics rather than inventing a persistent revision counter, checksum gate or alternative XMP pipeline. A rejected stale request must leave both photos, original bytes and history unchanged. File read errors should use the visible notice path, and the file input must reset on success or failure so retrying the same file remains possible.

## Verification required

Final tests must separately establish successful unchanged-target application, A-to-B rejection, same-photo changed-edit rejection, queue-time validation, visible read/parse errors, same-file retry, unchanged originals and ordinary unguarded CLI behavior. Injection must be labeled as such. Native CLI transport and real screenshots require native acceptance; the browser timing audit does not prove them. Final results belong in [acceptance](../docs/acceptance.md).
