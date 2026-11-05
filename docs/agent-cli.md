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

`processing --version 2` selects Linear processing for the active still photo; `--version 1` selects Original processing. Optional `--photoId` guards the intended selection. Both the detail selector and CLI use this command. `state` includes the stored `edit.processVersion` (absence means 1). Switching is undoable; reset and neutral comparison preserve the chosen version. Linear `export --format image/tiff` writes genuine 16-bit target-space samples, while PNG/JPEG/AVIF/JPEG XL use target-space 8-bit output. See [processing contracts and limits](linear-working-frames.md).

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

See [catalog organization](catalog-organization.md) for multi-selection, batch metadata and pasted edits, album rename/delete, filters, ordering, and named versions. `state.selection` lists selected IDs; `state.selected` identifies the active editor image. Their commands come from the shared schema, so `schema version-save`, `schema filter`, and `schema select-many` work offline without a separate CLI implementation.

[Photo merging](photo-merge.md) adds `merge-hdr`, `merge-panorama`, and `export-hdr`. Merge commands create a new library photo from selected originals and return registration/fusion diagnostics. `export-hdr --output merged.hdr` writes the actual retained scene-linear Radiance file; normal `preview` and `export` use the tone-mapped catalog image.

`export --format image/x-adobe-dng --output camera.dng` preserves an existing DNG or creates a true 16-bit LinearRaw DNG from a decodable camera RAW. See [DNG export](dng-export.md) for the difference, embedded settings, and validation limits. Rendered images are rejected as RAW sources.

[Optics and geometry](optics-geometry.md) adds `lens-profiles`, `lens-match`, `lens-apply`, `optics`, `optics-reset`, `straighten`, and the GUI `straighten-tool`. Profile matching returns exact metadata candidates for explicit application; corrections use real radial/channel and projective resampling. Original-coordinate local tools and XMP recipes share the same geometry.

[Catalog migration](catalog-migration.md) adds `migration-scan --catalog <local.lrcat>`, reviewed root mapping, `migration-inspect`, `migration-commit`, `migration-retry` and saved reports. `migration-apple-scan` accepts an authorized standard originals/XMP export folder. The scan does not read referenced originals; commit retains authorized disk references; explicit Sync uploads originals through the shared resolver and omits source-device paths from portable manifests. Genuine Adobe catalogs and PhotoKit are not claimed as tested.

## Shared-session transport

Rendered JPEG/PNG/TIFF/AVIF/JPEG XL accept `export --colorSpace display-p3` (also `srgb`, `adobe-rgb`, `prophoto-rgb`, `rec2020`). Pixels are actually converted and paired with generated ICC profiles. Preservation formats and video reject explicit color-space requests. GUI choices and CLI dispatch use the same capability owner. See [output color](export-color.md) for exact definitions, re-import and the current 8-bit sRGB editing boundary.

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

With the crop tool open, `state --summary true` exposes the uncommitted rectangle as normalized `cropDraft` coordinates. A completed pointer drag wakes observers. `crop-nudge --dx 1 --dy 0` moves the draft by one preview pixel, like the Right arrow. Use `crop-tool` to commit or `crop-cancel` to discard it.

`crop-drag --grip new --x1 0.25 --y1 0.25 --x2 0.75 --y2 0.75` draws a draft covering the center half of the corrected canvas in each dimension when the aspect ratio is unlocked. Use `move` or a compass handle such as `se` to reposition or resize it. Aspect constraints and boundary handling are shared with pointer dragging. Add `--capture crop.png` to inspect the draft before committing.

`crop-guide --type golden-spiral --orientation 1` selects a view-only composition guide through the same dispatcher as **Composition guide**. Full and summary `state` return `cropGuide:{type,orientation}` independently of `cropDraft`. Nine guide types and None are available; switching guides leaves draft, photo pixels and export unchanged. See [crop guides](crop-guides.md) for independent geometry definitions, orientation and session lifetime.
