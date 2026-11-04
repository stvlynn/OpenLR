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

## Arguments and output

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

## Shared-session transport

The MyGo host writes a session descriptor to the platform user configuration directory, `OpenLR/agent.json` (`%APPDATA%\OpenLR\agent.json` on Windows). `OPENLR_AGENT_FILE` or `--session` selects another descriptor. It contains a loopback URL, bearer token, PID, and protocol version. Do not commit or print the bearer token.

The CLI sends `POST /command` with `{command,args}` to that authenticated loopback service. `web/agent.js` polls `Desktop.AgentPoll`, calls the same `app.run` used by UI actions, and replies through `Desktop.AgentReply`. The response is `{ok:true,result}` or `{ok:false,error:{code,message}}`. Image results carry `{kind:'file',filename,mimeType,bytes,base64}`. Imported CLI files carry `{name,type,lastModified,base64}` and become browser `File` objects at the boundary.

The native command must reach the actual loaded window to succeed. A listening host alone does not prove the GUI bridge is ready. Requests have finite timeouts and surface disconnected or failed commands. Do not retry state-changing commands blindly after a transport timeout: inspect `state` first, because the original command may already have completed.

In a browser, `window.openlr.run(command,args)` exposes the same functions and returns native `Blob` results for images; `window.openlr.dispatch(command,args)` returns the serialized envelope. `window.openlr.commands`, `.schema(name)`, and `.search(query)` provide discovery. This browser API is useful for browser testing; the native CLI session belongs to the native window.
