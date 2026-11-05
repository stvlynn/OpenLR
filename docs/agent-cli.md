# Live GUI agent CLI

OpenLR exposes the same command queue to its controls, a browser automation API, and a native local CLI. Commands persist through the running GUI's catalog before completing. The CLI does not construct a separate catalog or emulate clicks.

The command workflow is inspired by [Cloudflare's cf agent guidance](https://developers.cloudflare.com/cf/agents/): discover commands, inspect their inputs, preview requests, and return machine-readable results. No Cloudflare dependency, account, or code is used.

```powershell
node cli/openlr.mjs cli search "adjust exposure"
node cli/openlr.mjs schema edit
node cli/openlr.mjs edit --key Exposure --value 0.5 --dry-run
node cli/openlr.mjs state
node cli/openlr.mjs import 'C:\Photos\example.jpg'
node cli/openlr.mjs view --mode detail
node cli/openlr.mjs edit --key Exposure --value 0.5
node cli/openlr.mjs preview --output preview.png
node cli/openlr.mjs export --format image/png --output edited.png
```

Run the native OpenLR GUI before commands that read or change live state. `cli search`, `schema`, `--help`, and `--dry-run` work without it. `web/agent-protocol.js` owns the command definitions used by discovery and validation. `web/app.js` owns the implementation and the serialized command queue.

The shared queue validates command arguments before executing an action or recording history. This also applies to direct `window.openlr.run` calls, so invalid crop coordinates or non-finite movement cannot corrupt the live draft through browser automation.

## Arguments and output

`processing --version 2` selects Linear processing for the active still photo; `--version 1` selects Original processing. Optional `--photoId` guards the intended selection. Both the detail selector and CLI use this command. `state` includes the stored `edit.processVersion` (absence means 1). Full and summary state also expose `processing:{version,input}`: `input` contains the matching decoded source's actual precision/depth and transform or compatibility provenance, or `null` while no matching source is cached. The detail Info text shows that decoded precision. Inspect this field to distinguish native PNG/TIFF/AVIF/JPEG XL samples from `rgba8-display` compatibility; Float32 storage alone does not recover source bits. Switching is undoable; reset and neutral comparison preserve the chosen version. Linear `export --format image/tiff` writes genuine 16-bit target-space samples, while PNG/JPEG/AVIF/JPEG XL use target-space 8-bit output. See [processing contracts and limits](linear-working-frames.md).

Both desktop commands and CLI-only commands such as `watch` appear in CLI search. Use `schema watch` for its invocation and output format. After the import path delimiter (`--`), even `--help` is a literal filename.

Use named options, or supply a JSON object with `--args` (`--body` is an alias). Import also accepts positional local paths or repeated `--file`. `--` marks the start of literal import paths. String arguments, including empty strings, can be provided through JSON when shell quoting is awkward.

```powershell
node cli/openlr.mjs schema export
node cli/openlr.mjs import --file 'C:\Photos\one.jpg' --file 'C:\Photos\two.png'
node cli/openlr.mjs edit --key aspect --value 1.5
node cli/openlr.mjs scope --id trash
node cli/openlr.mjs restore
```

Success prints JSON to standard output. Failures print a JSON error to standard error and exit nonzero. A dry run validates the request and prints it without contacting the GUI, importing files, or mutating state. It cannot establish current selection, file readability, codec support, or runtime readiness.

`preview` and `export` return actual image bytes from the current GUI edit state. `--output` writes them directly without a system dialog and prints the absolute result path, MIME type, and byte count. Existing files require `--force`. Without `--output`, images go to a unique file under `.workspace/agent-results/`. Use `--output -` with redirected stdout for raw image bytes. `preview` follows the original-comparison toggle; `export` applies committed edit state. No application-level file size ceiling is imposed; the current agent transport materializes base64 payloads in memory, so available RAM and runtime limits still constrain large imports and exports.

`state` returns the current scope and visible photos, selection, edit recipes, ratings, flags, keywords, and album metadata. Change scope or clear search before selecting a photo excluded by the current view. `delete` is reversible: it moves a catalog entry to Deleted; `restore` restores it while that photo is selected there. Undo/redo history lasts for the current GUI session.

`history-undo` and `history-redo` match the workspace keyboard shortcuts: Grid chooses the latest library or active-photo edit entry; Detail and Local use active-photo edits. Explicit `undo`/`redo` and `library-undo`/`library-redo` retain their narrower scopes.

See [catalog organization](catalog-organization.md) for multi-selection, batch metadata and pasted edits, album rename/delete, filters, ordering, and named versions. `state.selection` lists selected IDs; `state.selected` identifies the active editor image. Their commands come from the shared schema, so `schema version-save`, `schema filter`, and `schema select-many` work offline without a separate CLI implementation.

`copy-edits --keys '["Exposure","Contrast"]'` copies those recipe keys; selected keys absent from the source are reset on paste, while unselected target keys remain unchanged. Omitting `keys` copies the complete recipe. Optional `--photoId` rejects a changed active photo before replacing the clipboard; it does not select another source. The GUI's Choose edits dialog uses this same guarded command.

`curve-channel`, `curve-select` and `curve-set` expose the [point/channel curve editor](tone-curves.md). `curve-set` accepts an explicit channel and ordered normalized points; optional `photoId` and `expectedPoints` reject stale targets. Full and summary state expose `toneCurve:{channel,index}` alongside the persisted `edit.toneCurves`. Preview and export consume the same curve rules as the graph.

`grading-mode` and `grading-set` expose [color grading](color-grading.md). The latter replaces one validated owner with optional `photoId` and `expectedValue` guards. State exposes the selected grading view and the persisted photo recipe.

[Photo merging](photo-merge.md) adds `merge-hdr`, `merge-panorama`, and `export-hdr`. Merge commands create a new library photo from selected originals and return registration/fusion diagnostics. `export-hdr --output merged.hdr` writes the actual retained scene-linear Radiance file; normal `preview` and `export` use the tone-mapped catalog image.

`export --format image/x-adobe-dng --output camera.dng` preserves an existing DNG or creates a true 16-bit LinearRaw DNG from a decodable camera RAW. See [DNG export](dng-export.md) for the difference, embedded settings, and validation limits. Rendered images are rejected as RAW sources.

[Optics and geometry](optics-geometry.md) adds `lens-profiles`, `lens-match`, `lens-apply`, `optics`, `optics-reset`, `straighten`, and the GUI `straighten-tool`. Profile matching returns exact metadata candidates for explicit application; corrections use real radial/channel and projective resampling. Original-coordinate local tools and XMP recipes share the same geometry.

[Catalog migration](catalog-migration.md) adds `migration-scan --catalog <local.lrcat>`, reviewed root mapping, `migration-inspect`, `migration-commit`, `migration-retry` and saved reports. `migration-apple-scan` accepts an authorized standard originals/XMP export folder. The scan does not read referenced originals; commit retains authorized disk references; explicit Sync uploads originals through the shared resolver and omits source-device paths from portable manifests. Genuine Adobe catalogs and PhotoKit are not claimed as tested.

`edit --key Dehaze --value 35` adjusts the existing Effects control; negative values add haze and zero restores neutral behavior. The [dehaze contract](dehaze.md) describes source-resolution analysis and output limitations.

## Shared-session transport

Rendered formats accept `export --metadata copyright` or `--metadata supported`; the default `none` keeps the existing absence of source photo metadata. Policies are shared with GUI, `export-settings` and `export-previous`. The supported field list, Unicode/EXIF encoding and excluded location/private fields are specified in [photo metadata export](export-metadata.md).

`export --outputSharpening standard --maxSize 1600` applies [output sharpening](output-sharpening.md) at the final rendered size before watermark and output encoding. Levels are `none` (default), `low`, `standard` and `high`; the same setting is exposed by GUI, schema/discovery and previous-export reuse. It leaves the current recipe and preview unchanged. Non-none requests for preservation formats, DNG and video containers fail; rendered still-frame exports use the photo capability contract.

`export-previous --output next.png` reuses the current media type's last completed settings. `export-settings` inspects the independent photo/video slots; supplying `--media photo --options '{"format":"image/png"}'` explicitly configures one. The CLI remembers settings after its output write succeeds, including stdout completion, and leaves them unchanged on a refused overwrite or write failure. File responses for `export` and `export-previous` include captured `exportSettings`; direct browser API callers acknowledge their own save through `export-settings`. See [reuse and completion semantics](export-settings.md), including browser-download limits and legacy preference handling.

Rendered JPEG/PNG/TIFF/AVIF/JPEG XL accept `export --colorSpace display-p3` (also `srgb`, `adobe-rgb`, `prophoto-rgb`, `rec2020`). Pixels are actually converted and paired with generated ICC profiles. Preservation formats and video reject explicit color-space requests. GUI choices and CLI dispatch use the same capability owner. See [output color](export-color.md) for exact definitions, input/re-import color handling and the distinct Original/Linear precision boundaries.

Disk-backed Local commands (`local-folders`, `local-open`, `local-browse`, `library`) are documented in [Local folders](local-folders.md). [External editor](external-editors.md) commands (`external-editor`, `external-edit`, `external-check`) return a stable saved TIFF as a new derived photo. [Tethered capture](tethered-capture.md) adds `camera-list`, `tether`, and `camera-capture`; explicitly enabled camera simulators are always labeled as such.

[Shared albums](shared-albums.md) adds `share-configure`, `share-publish`, `share-reviews`, and `share-revoke`. These commands publish edited previews from the current library album to an independently deployed OpenLR review server and read browser comments/likes back into the same workspace.

The MyGo host writes a session descriptor to the platform user configuration directory, `OpenLR/agent.json` (`%APPDATA%\OpenLR\agent.json` on Windows). `OPENLR_AGENT_FILE` or `--session` selects another descriptor. It contains a loopback URL, bearer token, PID, and protocol version. Do not commit or print the bearer token.

The CLI sends `POST /command` with `{command,args}` to that authenticated loopback service. `web/agent.js` polls `Desktop.AgentPoll`, calls the same `app.run` used by UI actions, and replies through `Desktop.AgentReply`. The response is `{ok:true,result}` or `{ok:false,error:{code,message}}`. Image results carry `{kind:'file',filename,mimeType,bytes,base64}`. Imported CLI files carry `{name,type,lastModified,base64}` and become browser `File` objects at the boundary.

The native command must reach the actual loaded window to succeed. A listening host alone does not prove the GUI bridge is ready. A client may specify a deadline in seconds with --timeout. Do not retry state-changing commands blindly after a transport timeout: inspect `state` first, because the original command may already have completed.

The host writes a complete session descriptor to a temporary sibling before replacing `agent.json`. A CLI connecting during application startup or restart therefore cannot observe a partially written JSON document.

In a browser, `window.openlr.run(command,args)` exposes the same functions and returns native `Blob` results for images; `window.openlr.dispatch(command,args)` returns the serialized envelope. `window.openlr.commands`, `.schema(name)`, and `.search(query)` provide discovery. This browser API is useful for browser testing; the native CLI session belongs to the native window.

Use `openlr screenshot --output window.png` for the actual desktop viewport. On a data-returning command, `--capture path.png` returns its JSON result and a path to the captured window before the next queued edit runs. For example, `openlr edit --key Exposure --value 0.5 --capture edit.png`. File-returning commands already produce a separate image. Use `OPENLR_DAV_PASSWORD` for WebDAV credentials in unattended sync commands.

For a large catalog use `openlr state --summary true` and `openlr photos --offset 0 --limit 50`. To follow changes made by the person in the GUI or by another agent, run `openlr watch`. It writes newline-delimited JSON after committed changes. `--images <directory>` records actual window PNGs with each observed state, and `--count 2` ends after two records. Fast consecutive edits can coalesce into one observation.

An observer can sample a color, inspect lens profiles or migration reports, and request preview, mask or export bytes without triggering another update. Applying an edit wakes waiting observers.

`local-select --id <mask-id> --path "[1,0]"` selects a nested component in the same editor control as the person using the GUI. Omit the path to select the whole mask or repair. Both forms of `state` report `localSelection` with its root ID, component path and overlay visibility. `mask-preview` follows the selected component; an explicit `--id` exports coverage of that whole mask.

`local-tool --tool brush` uses the same activation as the GUI selector, opening Detail and leaving crop/compare/sampling. Both state shapes return `localTool` for the selected mode independently of `localSelection`; it can remain selected in Grid, so inspect `mode` as well. Use `off`, `brush`, `linear`, `radial`, `clone` or `heal`. Activation itself does not modify the recipe, and live observers receive the committed presentation change.

With the crop tool open, `state --summary true` exposes the uncommitted rectangle as normalized `cropDraft` coordinates. A completed pointer drag wakes observers. `crop-nudge --dx 1 --dy 0` moves the draft by one preview pixel, like the Right arrow. Use `crop-tool` to commit or `crop-cancel` to discard it.

`crop-drag --grip new --x1 0.25 --y1 0.25 --x2 0.75 --y2 0.75` draws a draft covering the center half of the corrected canvas in each dimension when the aspect ratio is unlocked. Use `move` or a compass handle such as `se` to reposition or resize it. Aspect constraints and boundary handling are shared with pointer dragging. Add `--capture crop.png` to inspect the draft before committing.

`crop-guide --type golden-spiral --orientation 1` selects a view-only composition guide through the same dispatcher as **Composition guide**. Full and summary `state` return `cropGuide:{type,orientation}` independently of `cropDraft`. Nine guide types and None are available; switching guides leaves draft, photo pixels and export unchanged. See [crop guides](crop-guides.md) for independent geometry definitions, orientation and session lifetime.

## Selection export

`export-selection --format image/png --output-dir ./exports --capture workspace.png` writes the selected visible group in display order, returns completed file paths/byte counts, and can capture the actual workspace. `--previous true` reuses each media slot. Single `export` still returns one active-photo file. See [batch export](batch-export.md) for IDs, mixed media, collisions, partial errors and completion semantics.

`export-status` and `export-cancel --id JOB_ID` remain responsive during a batch, independently of queued edits. `watch --command export-status --images ./progress` emits current job data and actual workspace captures. Cancellation requests are cooperative; wait for a terminal status before assuming output stopped. A timeout or disconnected observer does not cancel the batch. IDs and the latest terminal record are scoped to the current GUI session.

`album-rule --id ALBUM_ID --rule '{"text":"sunrise","rating":3,"flag":"pick","edited":"any"}'` replaces a smart album’s complete saved criteria, independently of temporary view filters. Read IDs/rules from `state`; all four fields are required. The command returns the saved album and supports `--capture`. Library undo/redo restores rules; identical saves do not create history. See [catalog organization](catalog-organization.md).

`local-tool --tool color-sample` activates range sampling through the shared tool transition. `range-color --args '{"x":0.25,"y":0.5,"id":"","path":[]}' --capture sampled.png` samples original-image coordinates into a new-range draft. Omit the target to refine the selected color-range mask/component; explicit `id`/`path` targets are also supported. Full/summary `state` return `rangeColor`; `localTool` reports the active sampler. Existing `sample-color` remains an edited-view color read. See [range tools](range-depth-tools.md).

## Point color selection

The Point color dropdown and `point-select --id SAMPLE_ID` share session selection. Full and summary `state` expose `selectedPoint`, the ID shown by the panel, or an empty string when the active photo has no samples. Read available IDs from that photo's `edit.pointColors`. Selection returns `{id}`, supports `--capture`, changes no recipe or undo history, and does not rerender photo pixels. Optional `photoId` rejects a queued selection intended for another photo; the GUI supplies it automatically. Unknown sample IDs reject without changing selection.

Adding a sample selects it only after saving succeeds. Removal, undo/redo, reset and recipe replacement retain a valid selection or fall back to the first remaining sample; no samples means empty selection. Changing photos selects the new photo's first sample, even if copied recipes contain the same sample IDs. This is session state, so reopening starts from the first available sample. `point-update` and `point-remove` continue to require explicit IDs and can operate on a sample other than the one shown. Activating the point eyedropper exits a pending straighten reference, including its first point. The eyedropper still adds a new sample from the edited image; selecting an existing point does not turn it into a replacement operation.

`tests/point-selection.test.js` exercises actual dropdown/sliders, shared command state, history and asset boundaries. Native smoke checks CLI selection, actual workspace capture and unchanged original bytes. Design evidence and the state-ownership comparison are in [point selection research](../research/point-color-selection.md).

## Applying a sidecar

`apply-xmp --xml XML --photoId PHOTO_ID` applies the existing XMP parser and persistence path to the current photo only when its ID matches. The guard is optional for callers that intentionally operate on execution-time selection; discover the current ID through `state`. A mismatch rejects before parsing, writing or adding history.

The GUI captures its intended photo and edit recipe before reading the chosen sidecar. After the asynchronous read, the shared dispatcher checks both the photo identity and the captured edit reference before applying it. Switching photos or editing the same photo while a read is pending therefore rejects the stale operation visibly; select the sidecar again to apply it to the new state. The file input clears after success or failure, and read errors are shown through the existing notice. The captured edit reference is internal session context, not a persisted revision or a new CLI precondition. Parsing, saved metadata/edits and undo retain their existing behavior.

The delayed-read tests in `tests/xmp-target.test.js` use actual file-input actions with explicitly injected pending I/O to make these boundaries deterministic. Evidence and alternatives are recorded in [asynchronous edit targets](../research/async-edit-targets.md); native CLI target checks remain separate from browser file-read injection.

`purge --expectedIds '["PHOTO_ID"]'` optionally verifies the exact current selection before permanently removing deleted library photos. Order and duplicate IDs do not change the set; it does not select photos itself. A changed selection rejects before the deletion transaction. The existing GUI confirmation supplies the IDs captured when it opened. Unguarded `purge` retains execution-time selection semantics. See [pending confirmations](catalog-organization.md#pending-confirmations).
