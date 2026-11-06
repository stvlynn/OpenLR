# Live GUI agent CLI

OpenLR exposes the same command queue to its controls, a browser automation API, and a native local CLI. Commands persist through the running GUI's catalog before completing. The CLI does not construct a separate catalog or emulate clicks.

The command workflow is inspired by [Cloudflare's cf agent guidance](https://developers.cloudflare.com/cf/agents/): discover commands, inspect their inputs, preview requests, and return machine-readable results. No Cloudflare dependency, account, or code is used.

```powershell
node cli/openlr.mjs open
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

Open the native GUI directly or use `open` before commands that read or change live state. From a packaged CLI, `open --dry-run` resolves the adjacent executable without launching it or contacting the GUI. Use `--app` to specify a different executable location. If the local broker is reachable and its renderer is still starting, `open` waits for that workspace. It returns `launched: false` with the existing workspace state. A new launch returns `launched: true` and the PID only when the responding session belongs to the started process.

`cli search`, `schema`, `--help`, and `--dry-run` work without a running GUI. `web/agent-protocol.js` owns the command definitions used by discovery and validation. `web/app.js` owns the implementation and the serialized command queue.

The shared queue validates command arguments before executing an action or recording history. This also applies to direct `window.openlr.run` calls, so invalid crop coordinates or non-finite movement cannot corrupt the live draft through browser automation.

`preferences` reads workspace settings; boolean arguments such as `--filenames false` update them. Startup waits for legacy migration when needed. Updates acknowledge only after the catalog's strict transaction completes; failed writes leave the previous in-memory settings intact. The settings dialog uses this same command for loading and saving. See [preference persistence](decisions/021-preference-persistence.md).

`rate`, `flag`, `keywords`, `label`, `capture-time`, `membership`, `delete`, `restore` and `paste-edits` accept `--expectedIds '["PHOTO_ID", "OTHER_ID"]'` to require that exact selected group when the queued command executes. A changed membership rejects without writing; order is ignored. Their GUI controls supply this guard. `rename` instead accepts a single active `photoId` guard. Without it, commands continue to use execution-time selection, including auto-advance.

`local-cancel` discards an in-progress brush, gradient or repair stroke and reports `{canceled:boolean}` without changing the selected tool or committed recipe. It shares the GUI Escape action and accepts an optional `--photoId` guard. Pointer cancellation and leaving the editing surface clear the same transient state; see [local tools](local-tools.md).

Photo-menu commands `virtual-copy`, `save-frame`, `red-eye`, `stack-cover`, `stack-toggle` and `unstack` accept an optional `--photoId` guard. `stack` also accepts it for the cover photo, plus `--expectedIds` for group membership. `cull` accepts `--expectedIds` for selection ownership; its existing `ids` still specifies the review order and targets. The GUI supplies these guards before queuing menu closure, and a mismatch writes nothing. No guard is required for ordinary CLI execution-time selection.

For `auto-stack`, `--expectedIds` instead checks the eligible photos in the current visible view: non-deleted photos outside existing stacks. Read those IDs from `state.photos`, excluding `deleted` and `stackId` records. Order and current selection do not affect this guard. GUI capture-time and similarity dialogs capture that set before opening, rejecting a changed set on confirmation. Without the guard, CLI grouping uses the execution-time view.

Full and summary `state` expose `clipping`, the current workspace highlight/shadow warning toggle. The `clipping` command, Histogram button and J shortcut share this state. Warnings affect the displayed canvas, not exported image pixels or edit recipes. Starting a color sampler clears them.

### Histogram

`histogram` and `histogram --source edited` return four arrays of 256 counts, named `red`, `green`, `blue` and `luma`. They measure the selected photo's committed edit even in Grid or while Detail shows the original. `histogram --source display` reads the same published Detail preview that the Histogram panel plots. It follows Show original, the edited pane in Compare side by side, and uncommitted crop or adjustment previews. It requires a published Detail preview for the current photo.

Both sources sample at up to 400 pixels on the long edge, skip fully transparent pixels and count rounded luma from the sRGB byte channels. The display source samples the current preview before clipping warnings are painted, so its sample size can depend on the preview scale. Run `node --test tests/histogram-workflow.test.js` to check the actual plot and both sources through comparison, clipping, a slider preview and Grid.

### Adjustment drafts

In Detail, add `--draft true` to `edit` for a numeric slider adjustment, `curve-set`, or `grading-set` to try a change on the actual editor surface without saving it. Use the same arguments and optional photo or edit guards as the corresponding saved command. Crop geometry has its own draft commands. Pause a playing video before staging an adjustment on its frame.

```sh
node cli/openlr.mjs edit --key Exposure --value 0.5 --draft true
node cli/openlr.mjs state --summary true
node cli/openlr.mjs preview --source draft --draftId ID --output draft.png
node cli/openlr.mjs draft-commit --id ID
node cli/openlr.mjs draft-cancel --id ID
```

Staging returns `{id,photoId,command,args,status}`. Full and summary `state` expose the same value as `adjustmentDraft`, or `null`. The initial status is `pending`. Follow `state` or `watch` until that ID reports `ready` before reading the image. A failed render reports `failed` with an error. A new update gets a new ID and supersedes the previous draft. The GUI's adjustment sliders, point-curve graph and grading gestures use the same staging path.

`preview --source draft` returns PNG bytes of the published edited pane, at its actual canvas dimensions and with any visible clipping warnings. It requires the current ready draft ID and accepts no `maxSize`. `--capture` remains a workspace screenshot. A capture taken while the draft is pending can show the previous canvas. Ordinary `preview`, `export` and `histogram --source edited` read their existing committed or comparison state. The display histogram follows the published draft.

Commit saves the typed change through the existing edit command as one undoable operation, subject to its usual guards and no-op rules. A pending draft can be committed without waiting for the trial image. If rendering has failed, cancel it or stage a new update. Cancel restores the committed view without changing the recipe or history. A replaced or invalidated draft ID cannot read, commit or cancel another draft. Drafts are session state and do not survive a catalog or view change. [Design and ownership](../research/adjustment-drafts.md) · [Desktop verification](desktop.md#verification-scope)

### Workspace panels

Full and summary `state` expose `panels`, a map from stable panel names to booleans. Use its keys to discover the available names. `photos` controls the Photos sidebar. The other keys use the original disclosure titles, including `Filters` when its displayed title includes a count.

```powershell
node cli/openlr.mjs state --summary true
node cli/openlr.mjs panel --name photos --open false --capture photos-hidden.png
node cli/openlr.mjs panel --name photos --open true
node cli/openlr.mjs panel --name 'Point curve' --open true
node cli/openlr.mjs panel --name Filters
```

`panel` returns the full workspace state. Pass `--open true` or `--open false` to set the disclosure, or omit `--open` to toggle the state when the command executes. Named inspector commands can reveal Detail and scroll an open section into view. Photos and catalog disclosures leave the current view mode in place. The booleans describe logical state for the current session. A section can stay open while its parent surface is hidden. Panel changes use no edit or catalog history.

Mouse, Enter and Space on a disclosure use the same queue as `panel` and publish changes to `watch`. P toggles Photos, Shift+P toggles Presets, and I toggles Info. Run `node --test tests/panel-state.test.js tests/local-gesture.test.js` to verify browser state, control visibility, keyboard routing and local stroke cancellation. The native main smoke checks CLI state, watch updates and Photos visibility in workspace captures.

Entering Grid ends an active slideshow and restores navigation, including `view --mode grid`, layout/scope changes, and a filter with no matching photos. GUI Grid and Escape use the same transition. `slideshow --stop true` ends playback while retaining the detail view. The full state reports whether the slideshow is active.

## Arguments and output

`repair-source` reads the live Clone/Heal source and picker state without changing it. After `local-tool --tool clone` (or `heal`), pass either `--point '{"x":0.25,"y":0.5}'` or `--picking true|false` to set the original-image source or start/cancel the GUI picker. Both state forms expose `repairSource:{point,picking}`. Optional `--photoId` guards reads and writes. The selected source is session state; `repair.add` remains the operation that commits a repair recipe. See [local tools](local-tools.md).

`straighten-tool --axis horizontal|vertical` starts the shared reference picker. Place the first point with a GUI click or `straighten-point --point '{"x":0.25,"y":0.35}'`. Both state forms and `watch` then show the original-image point in `straightenTool.first` and its `referenceId`. Submit the other point with the same command and `--referenceId ID` to save one edit. `straighten-tool --axis off` cancels, with the same optional ID guard. Both commands accept `--photoId`. Direct `straighten --start ... --end ...` still saves a complete reference in one call. [Optics and geometry](optics-geometry.md)

`processing --version 2` selects Linear processing for the active still photo; `--version 1` selects Original processing. Optional `--photoId` guards the intended selection. Both the detail selector and CLI use this command. `state` includes the stored `edit.processVersion` (absence means 1). Full and summary state also expose `processing:{version,input}`: `input` contains the matching decoded source's actual precision/depth and transform or compatibility provenance, or `null` while no matching source is cached. The detail Info text shows that decoded precision. Inspect this field to distinguish native PNG/TIFF/AVIF/JPEG XL samples from `rgba8-display` compatibility; Float32 storage alone does not recover source bits. Switching is undoable; reset and neutral comparison preserve the chosen version. Linear `export --format image/tiff` writes genuine 16-bit target-space samples, while PNG/JPEG/AVIF/JPEG XL use target-space 8-bit output. See [processing contracts and limits](linear-working-frames.md).

Both desktop commands and CLI-only commands such as `watch` appear in CLI search. Use `schema watch` for its invocation and output format. After the import path delimiter (`--`), even `--help` is a literal filename.

Use named options, or supply a JSON object with `--args` (`--body` is an alias). Import also accepts positional local paths or repeated `--file`. `--` marks the start of literal import paths. String arguments, including empty strings, can be provided through JSON when shell quoting is awkward.

Video imports declare a media type from the case-insensitive suffix for WebM, MOV, MP4, M4V and MKV. The running desktop still determines whether its codecs can open the file.

Video playback and audio use the native media element. When its pixels are origin-restricted, OpenLR decodes visual frames from the original file for thumbnails, the live editor, previews and still exports. On macOS, the thumbnail path waits for the first native frame presentation after media readiness. If the presentation callback is unavailable or does not arrive within two seconds of readiness, it copies the available frame. Older catalog video thumbnails refresh from the original and saved edit when the tile becomes visible. Pause and automatic trim-end stop prepare the frame at the captured playback position, then seek the paused media element to that position to anchor its clock. A later seek or asset change supersedes a pending pause. A saved frame uses the playback time captured for that command. Batch still export uses its own decoded frame at the saved trim start. Video-container exports require the selected format to retain every source track. [Native poster comparison](../research/native-video.md#poster-format-and-color-comparison)

Closing a player rejects its pending native media waits with `AbortError` and releases their listeners. Playback and seek report an existing native media error immediately. A media error during playback startup rejects the pending command. A synchronous failure while assigning a source or seek position preserves the original error and also removes the listeners. Run `node --test tests/video-media-lifecycle.test.js tests/video.test.js tests/video-audio-export.test.js` to verify this lifecycle alongside actual playback, frame pixels and audio export.

`video-toggle --photoId PHOTO_ID` uses the same Play/Pause action as the video bar. It reads the clip's actual playback state when the command executes and returns the resulting `playback` state. `video-play` and `video-pause` remain available for explicit playback requests. `video-seek --time 0.75` moves the playhead, and `video-trim --start 0.5 --end 1.5` saves the trim and moves the playhead to its start. The video bar sends the ID of the clip it displays for Play/Pause, seeking and trimming. The `photoId` guard is optional for these three CLI commands.

Sample-accurate audio export supports mono and stereo 48 kHz Opus and 44.1/48 kHz AAC-LC. It uses the bundled Opus decoder and selects WebCodecs or macOS AudioToolbox according to the source and output codec configuration. The selected samples share the video trim timeline, including delayed starts and gaps. In a mixed export, every additional track needs a codec that preserves its sample rate and channels. A replacement track with no audible overlap fails before saving. Other formats and layouts retain the ordinary conversion path when available. Cancellation closes the export's codec handles. The tested configurations and commands are recorded in [the audio export record](../research/native-audio-export.md).

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

`grading-mode` and `grading-set` expose [color grading](color-grading.md). With `value`, the latter replaces one validated owner with optional `photoId` and `expectedValue` guards. Alternatively, `--photoId PHOTO --patch '{"field":"blending","value":80,"expectedValue":50}'` updates only that field against its expected previous value, preserving other queued changes. A patch requires the photo guard and cannot be combined with a full replacement. Wheel fields use paths such as `global.luminance`. State exposes the selected grading view and the persisted photo recipe.

[Photo merging](photo-merge.md) adds `merge-hdr`, `merge-panorama`, and `export-hdr`. Merge commands create a new library photo from selected originals and return registration/fusion diagnostics. `export-hdr --output merged.hdr` writes the actual retained scene-linear Radiance file; normal `preview` and `export` use the tone-mapped catalog image.

`export --format image/x-adobe-dng --output camera.dng` preserves an existing DNG or creates a true 16-bit LinearRaw DNG from a decodable camera RAW. See [DNG export](dng-export.md) for the difference, embedded settings, and validation limits. Rendered images are rejected as RAW sources.

[Optics and geometry](optics-geometry.md) adds `lens-profiles`, `lens-match`, `lens-apply`, `optics`, `optics-reset`, `straighten`, and the GUI `straighten-tool`. Profile matching returns exact metadata candidates for explicit application; corrections use real radial/channel and projective resampling. Original-coordinate local tools and XMP recipes share the same geometry.

[Catalog migration](catalog-migration.md) adds `migration-scan --catalog <local.lrcat>`, reviewed root mapping, `migration-inspect`, `migration-commit`, `migration-retry` and saved reports. `migration-apple-scan` accepts an authorized standard originals/XMP export folder. The scan does not read referenced originals; commit retains authorized disk references; explicit Sync uploads originals through the shared resolver and omits source-device paths from portable manifests. Genuine Adobe catalogs and PhotoKit are not claimed as tested.

`edit --key Dehaze --value 35` adjusts the existing Effects control; negative values add haze and zero restores neutral behavior. The command awaits background source analysis, Original byte conversion and required thumbnail persistence before replying; preview/export await their captured recipe. Linear retains floating reconstruction. The [dehaze contract](dehaze.md) describes source-resolution analysis and output limitations.

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

`viewport` reads or moves an existing scrollport and returns its live `{x, y, width, height, maxX, maxY}` in CSS pixels. It defaults to Detail. After `zoom`, use `viewport --x 300 --y 200 --capture detail.png` to inspect another part of a full-resolution photo. Targets `grid` and `filmstrip` move the thumbnail views. Use `viewport --target photos --y 600 --capture albums.png` for the Photos sidebar or `viewport --target inspector --y 400 --capture inspector.png` to inspect controls inside an open section. Selecting a scope retains the existing sidebar position. The `panel` command still brings a named Inspector section into view.

The target must be visible. Grid and Photos can be visible in an empty library. Inspector is available with a nondeleted photo in Detail and the Inspector shown. Filmstrip, Photos and Inspector are unavailable during slideshow. Coordinates are absolute, nonnegative and clamped to the actual scrollable range. An omitted axis keeps its current position. `--photoId` optionally guards the current selection. The command preserves selection, zoom, and edit state. Full and summary state expose `viewport` for Detail, `catalogViewports: {grid, filmstrip}` for the thumbnails and `panelViewports: {photos, inspector}` for the sidebars. Hidden entries are null.

Actual scrolling by the GUI or command wakes `watch`. Reading offsets or requesting their current values emits no change. Use capture to see the scrolled workspace. Photo preview and export continue to return the requested image independently of scroll position. [Panel viewport evidence](../research/panel-viewport.md)

Offsets may be fractional at native display scaling, while browser extent measurements are integer-rounded; an applied endpoint can differ from `maxX`/`maxY` by up to one CSS pixel. Read the returned actual offsets instead of assuming exact equality with rounded extents.

For a large catalog use `openlr state --summary true` and `openlr photos --offset 0 --limit 50`. To follow changes made by the person in the GUI or by another agent, run `openlr watch`. It writes newline-delimited JSON after committed changes. `--images <directory>` records actual window PNGs with each observed state, and `--count 2` ends after two records. Fast consecutive edits can coalesce into one observation.

An observer can read a color with `sample-color`, inspect lens profiles or migration reports, and request preview, mask or export bytes without triggering another update. Applying an edit wakes waiting observers.

`local-select --id <mask-id> --path "[1,0]"` selects a nested component in the same editor control as the person using the GUI. Omit the path to select the whole mask or repair. Both forms of `state` report `localSelection` with its root ID, component path and overlay visibility. `mask-preview` follows the selected component; an explicit `--id` exports coverage of that whole mask.

`local-tool --tool brush` uses the same activation as the GUI selector, opening Detail and leaving crop/compare/sampling. Both state shapes return `localTool` for the selected mode independently of `localSelection`; it can remain selected in Grid, so inspect `mode` as well. Use `off`, `brush`, `linear`, `radial`, `clone` or `heal`. Activation itself does not modify the recipe, and live observers receive the committed presentation change.

With the matching local tool active, stage a Brush, Linear or Radial mask with `mask.add --draft true`, or a Clone or Heal stroke with `repair.add --draft true`. The typed geometry remains in `state.localDraft` until replaced, canceled or committed. `preview --source local-draft --draftId ID` reads the actual displayed overlay as a transparent PNG. `draft-commit` and `draft-cancel` use that ID. [Local stroke coordinates and examples](local-tools.md#cli)

With the crop tool open, `state --summary true` exposes the uncommitted rectangle as normalized `cropDraft` coordinates. A completed pointer drag wakes observers. `crop-nudge --dx 1 --dy 0` moves the draft by one preview pixel, like the Right arrow. Use `crop-tool` to commit or `crop-cancel` to discard it.

`compare` (Show original) exits the crop tool and discards its uncommitted rectangle, matching the existing side-by-side comparison transition. It displays the neutral original for the selected processing version. Saved crop and other edits remain intact; turning comparison off restores their rendered result. Switching comparison does not create an undo entry.

`crop-drag --grip new --x1 0.25 --y1 0.25 --x2 0.75 --y2 0.75` draws a draft covering the center half of the corrected canvas in each dimension when the aspect ratio is unlocked. Use `move` or a compass handle such as `se` to reposition or resize it. Aspect constraints and boundary handling are shared with pointer dragging. Add `--capture crop.png` to inspect the draft before committing.

`crop-guide --type golden-spiral --orientation 1` selects a view-only composition guide through the same dispatcher as **Composition guide**. Full and summary `state` return `cropGuide:{type,orientation}` independently of `cropDraft`. Nine guide types and None are available; switching guides leaves draft, photo pixels and export unchanged. See [crop guides](crop-guides.md) for independent geometry definitions, orientation and session lifetime.

`rotate --direction right --photoId PHOTO_ID` and `flip --photoId PHOTO_ID` perform the same relative edits as **Rotate left**, **Rotate right** and **Flip horizontal**. Each action uses the active recipe when it reaches the dispatcher, saves one undoable edit and returns full state. The GUI supplies the photo selected at click time. An optional `photoId` lets a CLI caller reject a change of selection as well. Use `edit --key turn --value 2` or `edit --key flip --value false` to set an absolute value. Use `--capture` for the resulting workspace or `preview --output rotated.png` for rendered image bytes.

Basic adjustment sliders, aspect changes and **Clear crop** also submit the photo ID when they commit `edit`. A CLI caller can use `edit --key Exposure --value 0.5 --photoId PHOTO_ID` to guard its target, or omit `photoId` to use the active photo at execution.

`grid-layout` without arguments switches between Square and Mosaic like the toolbar button. `grid-layout --layout mosaic` selects an explicit layout. Both open Grid, persist the choice and return the new `gridLayout` in workspace state. Consecutive switches each act on the previous queued result.

`select-relative --direction next` and `select-relative --direction previous` navigate the current visible photo order like Right and Left outside crop editing. Each action uses the selection and visible order at execution. The command returns full state and stops at the ends without wrapping or changing the workspace. Use `select --id PHOTO_ID` for an explicit target.

## Selection export

`export-selection --format image/png --output-dir ./exports --capture workspace.png` writes the selected visible group in display order, returns completed file paths/byte counts, and can capture the actual workspace. `--previous true` reuses each media slot. Single `export` still returns one active-photo file. See [batch export](batch-export.md) for IDs, mixed media, collisions, partial errors and completion semantics.

`export-status` and `export-cancel --id JOB_ID` remain responsive during a batch, independently of queued edits. `watch --command export-status --images ./progress` emits current job data and actual workspace captures. Cancellation requests are cooperative; wait for a terminal status before assuming output stopped. A timeout or disconnected observer does not cancel the batch. IDs and the latest terminal record are scoped to the current GUI session.

`album-rule --id ALBUM_ID --rule '{"text":"sunrise","rating":3,"flag":"pick","edited":"any"}'` replaces a smart album’s complete saved criteria, independently of temporary view filters. Read IDs/rules from `state`; all four fields are required. The command returns the saved album and supports `--capture`. Library undo/redo restores rules; identical saves do not create history. See [catalog organization](catalog-organization.md).

`local-tool --tool color-sample` activates range sampling through the shared tool transition. `range-color --args '{"x":0.25,"y":0.5,"id":"","path":[]}' --capture sampled.png` samples original-image coordinates into a new-range draft. Omit the target to refine the selected color-range mask/component; explicit `id`/`path` targets are also supported. Full/summary `state` return `rangeColor`; `localTool` reports the active sampler. Existing `sample-color` remains an edited-view color read. See [range tools](range-depth-tools.md).

## Point color sampling

`point-tool` activates the Point color eyedropper in Detail and clears clipping warnings and any pending straighten reference. Click the edited image or run `point-sample --x 0.25 --y 0.5 --photoId PHOTO_ID`. Coordinates are fractions of the whole displayed edited canvas, including at zoom, with `0,0` at the top left and `1,1` at the last pixel. The sample is one 8-bit sRGB canvas pixel after edits and geometry at the current preview scale. Video uses the published frame. Full `state` reports `sampling:"point"` while the eyedropper is active.

The command requires the current photo's committed edited preview. It rejects a stale click, an uncommitted adjustment preview, or an optional `photoId` that no longer matches. If clipping warnings are turned on while the eyedropper is active, turn them off before sampling. A successful sample returns the saved point `{id,color,hue,saturation,luminance,range}`, selects it, ends sampling, and adds one undo entry. Each success creates a new sample, including when another point is already selected.

`point-add --color '#406080'` adds an explicit sRGB color. `sample-color --x 0.25 --y 0.5` reads the committed edited image with a 1280-pixel long-edge limit, independent of preview scale or active tool, and returns `{color}`.

## White balance sampling

Click **White balance sampler**, press **W**, or run `sample-tool` to activate the picker in Detail. Full `state` reports `sampling:"white"`. Click the edited image or run `white-balance-sample --x 0.25 --y 0.5 --photoId PHOTO_ID`. Both accept fractions of the whole displayed canvas, including at zoom, and reverse crop, rotation, flip and optics to find the patch on the decoded original. Transparent points outside the corrected source are rejected. Clipping warnings do not affect the original sample.

The display command requires the current photo's committed preview and rejects a superseded clicked canvas, a draft adjustment preview or an optional `photoId` that no longer matches. `white-balance --x 0.25 --y 0.5 --photoId PHOTO_ID` accepts original-image coordinates directly and works without the picker. Both commands use the same 5×5 original neighborhood, save Temperature and Tint as one undoable edit, end sampling after success and return full state. During video playback the sampler reads the decoded source at execution time. Pause the video first to sample a specific frame.

Run `node --test tests/white-balance.test.js` for actual canvas clicks, transformed coordinates, preview and export pixels, undo/redo, reload, original bytes and controlled stale-click timing. The native main smoke also runs both CLI coordinate paths, captures the workspace and checks changed preview pixels and undo. The reproduced defect and preview ownership decision are recorded in [asynchronous edit targets](../research/async-edit-targets.md#white-balance-display-sampling).

## Point color selection

The Point color dropdown and `point-select --id SAMPLE_ID` share session selection. Full and summary `state` expose `selectedPoint`, the ID shown by the panel, or an empty string when the active photo has no samples. Read available IDs from that photo's `edit.pointColors`. Selection returns `{id}`, supports `--capture`, changes no recipe or undo history, and does not rerender photo pixels. Optional `photoId` rejects a queued selection intended for another photo; the GUI supplies it automatically. Unknown sample IDs reject without changing selection.

Adding a sample selects it only after saving succeeds. Removal, undo/redo, reset and recipe replacement retain a valid selection or fall back to the first remaining sample. Selection is empty when there are no samples. Changing photos selects the new photo's first sample, even if copied recipes contain the same sample IDs. This is session state, so reopening starts from the first available sample. `point-update` and `point-remove` require explicit sample IDs and can act on a sample other than the one shown. Both accept an optional `photoId` guard. The panel supplies its displayed photo ID when a slider commits or **Delete sample** is clicked.

`tests/point-selection.test.js` exercises actual dropdown/sliders, shared command state, history and asset boundaries. Native smoke checks CLI selection, actual workspace capture and unchanged original bytes. Design evidence and the state-ownership comparison are in [point selection research](../research/point-color-selection.md).

## Applying a sidecar

`apply-xmp --xml XML --photoId PHOTO_ID` applies the existing XMP parser and persistence path to the current photo only when its ID matches. The guard is optional for callers that intentionally operate on execution-time selection; discover the current ID through `state`. A mismatch rejects before parsing, writing or adding history.

The GUI captures its intended photo and edit recipe before reading the chosen sidecar. After the asynchronous read, the shared dispatcher checks both the photo identity and the captured edit reference before applying it. Switching photos or editing the same photo while a read is pending therefore rejects the stale operation visibly; select the sidecar again to apply it to the new state. The file input clears after success or failure, and read errors are shown through the existing notice. The captured edit reference is internal session context, not a persisted revision or a new CLI precondition. Parsing, saved metadata/edits and undo retain their existing behavior.

The delayed-read tests in `tests/xmp-target.test.js` use actual file-input actions with explicitly injected pending I/O to make these boundaries deterministic. Evidence and alternatives are recorded in [asynchronous edit targets](../research/async-edit-targets.md); native CLI target checks remain separate from browser file-read injection.

`purge --expectedIds '["PHOTO_ID"]'` optionally verifies the exact current selection before permanently removing deleted library photos. Order and duplicate IDs do not change the set; it does not select photos itself. A changed selection rejects before the deletion transaction. The existing GUI confirmation supplies the IDs captured when it opened. Unguarded `purge` retains execution-time selection semantics. See [pending confirmations](catalog-organization.md#pending-confirmations).
