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

Native adapters for [Local folders](local-folders.md), [external editor roundtrips](external-editors.md), [tethered capture](tethered-capture.md) and [shared album publication](shared-albums.md) all route through the same GUI command dispatcher and agent transport. Their separate documentation records filesystem/network boundaries and their actual validation scope.

`saveExport(blob, filename)` in `web/desktop.js` returns `true` after completion, `false` when a native save dialog is canceled, and throws on failure. It uses `Desktop.BeginExport`, `WriteExport`, `FinishExport` and `CancelExport` in MyGo. Browser preview uses an ordinary Blob download. The transfer uses bounded-memory chunks and has no fixed total size cap. Temporary files protect an existing destination until transfer completion; the file replacement operation follows the host filesystem's semantics.

The host's local agent endpoint is recorded in `os.UserConfigDir()/OpenLR/agent.json` (on Windows `%APPDATA%/OpenLR/agent.json`), or the path in `OPENLR_AGENT_FILE`. Its JSON fields are `version`, `url`, `token` and `pid`. Requests must send `Authorization: Bearer <token>`; the endpoint listens only on a random loopback port. `GET /health` returns availability. `POST /command` accepts `{command,args}`, waits for `web/agent.js` to run the command on live application state, and returns that bridge's JSON response. A pending request ends when the GUI replies, the client disconnects, or the app closes. Connection data is local machine state and must not be committed or shared.

## Verification scope

If the native main smoke fails during startup, it reports bounded, read-only broker/control diagnostics before cleanup and rethrows the original failure. Session publication is distinct from renderer and catalog readiness. The probes do not retry the failed command or extend its deadline; see [startup evidence and interpretation](../research/native-startup.md). Their transport checks run with `node --test tests/native-startup-diagnostics.test.js` and are not GUI acceptance.

Go tests cover a real 65 MiB streamed export, replacement only after completion, cancel cleanup, agent authentication and command/reply routing. These tests do not display the native save dialog. Windows runtime and other operating systems must be reported separately from compilation. The architecture choice and source links are in [decision 001](decisions/001-mygo-desktop.md).

On 2026-11-05, the Windows/amd64 package launched on WebView2 156.0.4314.58, and the agent CLI read its live catalog through HTTP → MyGo IPC → frontend. Native import, edit, preview and export commands were also exercised against that running window. `go test ./...` and `go vet ./...` passed. The filesystem tests needed execution outside the restricted Windows sandbox because it denied replacement of a temporary destination; they passed against the normal Windows filesystem. `mygo doctor` passed Go and WebView2 checks. Later [three-platform verification](https://github.com/stvlynn/OpenLR/actions/runs/41951556522) built the official distributions and ran all seven native GUI/CLI suites on Windows, Ubuntu 24.04 and macOS 15 Intel. The universal macOS artifact does not establish execution on Apple Silicon. Signing, notarization and native save-dialog interaction remain separate validation steps.

Official packages include the single-file Node CLI under cli/openlr.mjs in the native resource directory. Run it with Node 24. The build command bundles the shared schema and CLI implementation from this checkout.

## Local Linux acceptance

Use a Linux checkout with Linux-installed `node_modules`, Go 1.27.3+ and Node 24. When running under WSL, keep the checkout and Go caches in a persistent Linux directory; do not reuse Windows native npm binaries or assume `/tmp` survives separate WSL invocations. The complete suite also needs Chrome for the shared-album visitor browser, in addition to the application's WebKitGTK runtime.

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-0 xvfb
npm ci
google-chrome --version
go test ./...
go test -race ./...
go vet ./...
node scripts/desktop.mjs build -o build/release -platform linux/amd64
xvfb-run -a dbus-run-session -- node scripts/native-suite.mjs build/release/linux-amd64/openlr
```

Install Chrome from its official Linux distribution before the version check if absent. Set `OPENLR_TEST_METADATA=1` when the independent [ExifTool oracle](export-metadata.md) has been provisioned, so missing validation tools fail visibly. Xvfb runs the real GTK/WebKit application and IPC bridge; it does not establish physical display, GPU, native chooser, signing or macOS behavior. Application test sessions use isolated temporary catalogs.
