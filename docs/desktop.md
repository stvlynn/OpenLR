# Desktop host

The native host pins MyGo **v0.7.4** and requires **Go 1.27.3+**. The Go tool dependency runs the same CLI version as the runtime. `scripts/desktop.mjs` uses `GO_BINARY`, then a workspace-local `.tools/go/bin/go`, then `go` from PATH. Module/build caches default to ignored `.tools/` directories.

```sh
node scripts/desktop.mjs doctor
node scripts/desktop.mjs dev
node scripts/desktop.mjs build
node scripts/desktop.mjs build -platform darwin/universal,windows/amd64,linux/amd64
```

The CLI embeds `web/` without a frontend build step. Packaged output goes to `build/<os>-<arch>/`. `-skip-installer` avoids the Windows installer/NSIS download; `-skip-dmg` skips macOS disk images. Normal `go build` also embeds the frontend, but the MyGo CLI adds application identity, icons, manifests and packaging and is the distribution path.

Windows 10 needs the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/); Windows 11 includes it. Linux needs GTK 3 and WebKitGTK 4.1 (`libwebkit2gtk-4.1-0` on Debian/Ubuntu). macOS 12+ uses the system WKWebView. There is no Android/iOS host in this project. Signed public releases require the publisher's own signing configuration.

## Native boundary

`saveExport(blob, filename)` in `web/desktop.js` returns `true` after completion, `false` when a native save dialog is canceled, and throws on failure. It uses `Desktop.BeginExport`, `WriteExport`, `FinishExport` and `CancelExport` in MyGo. Browser preview uses an ordinary Blob download. The transfer uses bounded-memory chunks and has no fixed total size cap. Temporary files protect an existing destination until transfer completion; the file replacement operation follows the host filesystem's semantics.

The host's local agent endpoint is recorded in `os.UserConfigDir()/OpenLR/agent.json` (on Windows `%APPDATA%/OpenLR/agent.json`), or the path in `OPENLR_AGENT_FILE`. Its JSON fields are `version`, `url`, `token` and `pid`. Requests must send `Authorization: Bearer <token>`; the endpoint listens only on a random loopback port. `GET /health` returns availability. `POST /command` accepts `{command,args}`, waits for `web/agent.js` to run the command on live application state, and returns that bridge's JSON response. A pending request times out after two minutes. Connection data is local machine state and must not be committed or shared.

## Verification scope

Go tests cover a real 65 MiB streamed export, replacement only after completion, cancel cleanup, agent authentication and command/reply routing. These tests do not display the native save dialog. Windows runtime and other operating systems must be reported separately from compilation. The architecture choice and source links are in [decision 001](decisions/001-mygo-desktop.md).

On 2026-11-05, the Windows/amd64 package launched on WebView2 156.0.4314.58, and the agent CLI read its live catalog through HTTP → MyGo IPC → frontend. Native import, edit, preview and export commands were also exercised against that running window. `go test ./...` and `go vet ./...` passed. The filesystem tests needed execution outside the restricted Windows sandbox because it denied replacement of a temporary destination; they passed against the normal Windows filesystem. `mygo doctor` passed Go and WebView2 checks. macOS universal `.app` and Linux/amd64 executable, Debian package and archive were built by the official CLI; their runtime behavior was not tested on those operating systems. Signing, notarization and native save-dialog interaction remain separate validation steps.
