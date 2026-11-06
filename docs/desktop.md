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

WebM export on Linux uses WebKitGTK's GStreamer plugins for Opus, VP9 and its parser. The Debian package declares `gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-good`, and `gstreamer1.0-plugins-bad`. The Arch PKGBUILD declares the corresponding `gst-plugins-base`, `gst-plugins-good`, and `gst-plugins-bad` packages. Install these runtime packages when running directly from the archive. [Ubuntu parser package](https://packages.ubuntu.com/noble/gstreamer1.0-plugins-bad) · [Arch parser package](https://archlinux.org/packages/extra/x86_64/gst-plugins-bad-libs/files/)

## Native boundary

The CI matrix includes both `macos-15-intel` and `macos-15`. GitHub documents these as Intel and Apple Silicon runners respectively. Each builds the universal package and runs the same native CLI/image workflows on its host architecture; artifact names include the runner label to keep the two results distinct. Adding a job is not evidence that it passed: exact runtime results remain in [acceptance](acceptance.md). [GitHub runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

Native adapters for [Local folders](local-folders.md), [external editor roundtrips](external-editors.md), [tethered capture](tethered-capture.md) and [shared album publication](shared-albums.md) all route through the same GUI command dispatcher and agent transport. Their separate documentation records filesystem/network boundaries and their actual validation scope.

`saveExport(blob, filename)` in `web/desktop.js` returns `true` after completion, `false` when a native save dialog is canceled, and throws on failure. It uses `Desktop.BeginExport`, `WriteExport`, `FinishExport` and `CancelExport` in MyGo. Browser preview uses an ordinary Blob download. The transfer uses bounded-memory chunks and has no fixed total size cap. Temporary files protect an existing destination until transfer completion; the file replacement operation follows the host filesystem's semantics.

The host's local agent endpoint is recorded in `os.UserConfigDir()/OpenLR/agent.json` (on Windows `%APPDATA%/OpenLR/agent.json`), or the path in `OPENLR_AGENT_FILE`. Its JSON fields are `version`, `url`, `token` and `pid`. Requests must send `Authorization: Bearer <token>`; the endpoint listens only on a random loopback port. `GET /health` returns availability. `POST /command` accepts `{command,args}`, waits for `web/agent.js` to run the command on live application state, and returns that bridge's JSON response. A pending request ends when the GUI replies, the client disconnects, or the app closes. Connection data is local machine state and must not be committed or shared.

## Verification scope

`npm run test:native -- /path/to/OpenLR` runs eighteen sequential workflows against the built application, covering core editing, catalog organization, mask coverage/removal, Sky segmentation, composite masks/repairs, depth/blur, enhancement, culling/red-eye, optics/auto tone, navigation, adjustment drafts, video, local folders, migration, external editing, camera simulation, shared review, and integration. Windows adds two workflows for two-profile WebDAV synchronization and executable file-open delivery, for twenty in total. Model workflows fetch pinned weights in fresh native sessions and require access to their documented hosts. The shared private-process lifecycle isolates adapter files and uses a short temporary MyGo socket path. Organization, navigation and culling restart the host on Windows and Linux using private WebView2 or WebKitGTK profiles. The macOS workflows use ephemeral WebKit sessions. Windows sync alternates two private profiles. Navigation enables loopback debugging for its disposable Windows child to inspect the actual fullscreen viewport, filename labels and trusted keyboard input. The video workflow uses Chrome as its fixture encoder and independent output decoder. [Video verification](../research/native-video.md)

Run `node scripts/native-adjustment-smoke.mjs /path/to/OpenLR` to verify adjustment drafts through the packaged application's CLI. The check compares every decoded Exposure sample against a generated sRGB fixture, checks center samples for curve and grading drafts, and confirms the draft appears in the workspace capture and display histogram. It verifies cancellation, stale IDs, one undoable commit and unchanged original bytes. A generated local folder lets the check restart on every platform and verify that the committed sidecar survives and the abandoned draft is gone.

If the native main smoke fails during startup, it reports bounded, read-only broker/control diagnostics before cleanup and rethrows the original failure. Session publication is distinct from renderer and catalog readiness. The probes do not retry the failed command or extend its deadline; see [startup evidence and interpretation](../research/native-startup.md). Their transport checks run with `node --test tests/native-startup-diagnostics.test.js` and are not GUI acceptance.

The shared native test harness starts one child before entering the workflow. A workflow can await `stop()` and `start()` to switch between isolated profiles without discarding either profile. The existing `restart()` composes both operations for one profile. The harness refuses a second start while the previous child is active or its closure is unconfirmed. At the end of the workflow, it removes the disposable profile after confirmed closure. If closure is unconfirmed, it retains the workspace and reports the temporary directory's name. An existing workflow error still determines the test failure. Run `node --test tests/native-workspace.test.js` for the controlled lifecycle checks.

On WSL Ubuntu with WebKitGTK 2.52.6, two profiles launched sequentially under Xvfb began with empty catalogs and default preferences. Each reopened with its own photo ID, rating, exposure and preferences. Original exports matched their fixture bytes. Both IndexedDB and local storage files were observed under their respective temporary XDG directories before cleanup.

Go tests cover a real 65 MiB streamed export, replacement only after completion, cancel cleanup, agent authentication and command/reply routing. These tests do not display the native save dialog. Windows runtime and other operating systems must be reported separately from compilation. The architecture choice and source links are in [decision 001](decisions/001-mygo-desktop.md).

On 2026-11-05, the Windows/amd64 package launched on WebView2 156.0.4314.58, and the agent CLI read its live catalog through HTTP → MyGo IPC → frontend. Native import, edit, preview and export commands were also exercised against that running window. `go test ./...` and `go vet ./...` passed. The filesystem tests needed execution outside the restricted Windows sandbox because it denied replacement of a temporary destination; they passed against the normal Windows filesystem. `mygo doctor` passed Go and WebView2 checks. Later [three-platform verification](https://github.com/stvlynn/OpenLR/actions/runs/41951556522) built the official distributions and ran all seven native GUI/CLI suites on Windows, Ubuntu 24.04 and macOS 15 Intel. The universal macOS artifact does not establish execution on Apple Silicon. Signing and notarization remain separate validation steps. The later Windows Save dialog check observed cancellation and successful output through the desktop GUI. [Export settings verification](export-settings.md#verification)

Official packages include the single-file Node CLI under cli/openlr.mjs in the native resource directory. Run it with Node 24. The build command bundles the shared schema and CLI implementation from this checkout.

The shared installed CLI check runs from an isolated working directory, resolves the executable via `open --dry-run`, and attaches to the live workspace via `open` after importing a test photo. It also reads the rendered pixels and original bytes. The Windows cold-launch check used a fresh MyGo profile and the rebuilt bundled CLI, confirmed that its reported process ID matched the live broker, and reopened the same workspace without another launch. [CLI startup behavior](agent-cli.md)

## Windows installer verification

Desktop CI runs `scripts/native-installer-smoke.ps1` in a fresh Windows runner account. It installs the generated NSIS executable silently to a temporary path containing spaces. It checks the installed path, Start Menu shortcut, all configured Open With registrations and their command targets. The installed CLI runs from outside the source tree, imports a generated PNG into the installed desktop, and reads back catalog state, the actual preview pixels and exact original bytes. The uninstaller removes the program, shortcut and registrations. The initial run passed with six associations and a 32×24 preview. This covers the silent installer and registration; the separate Windows file-open smoke exercises delivery of photo arguments to the application. [Initial installer run](https://github.com/stvlynn/OpenLR/actions/runs/42275482733/job/128090613072) · [NSIS command line](https://nsis.sourceforge.io/Docs/Chapter3.html)

## Linux and macOS installer verification

On the hosted Ubuntu runner, APT installs the generated Debian package and Xvfb with the reduced recommendation policy. The package declares the GTK, WebKitGTK and GStreamer runtime dependencies. The check verifies the installed command, desktop entry and MIME registration files, then launches `/usr/bin/openlr` for the shared installed-CLI check and the complete native suite. It purges the package and checks removal of the command, payload and integration files. The first run passed the complete Xvfb suite with actual VP9/Opus export. [Debian installation run](https://github.com/stvlynn/OpenLR/actions/runs/42277094106) · [Ubuntu package manager](https://manpages.ubuntu.com/manpages/noble/man1/dpkg.1.html)

On each hosted macOS architecture, the disk image is mounted read-only, and the application is copied with `ditto` to an isolated Applications directory. After detaching the image, the copied application and its resource-directory CLI run the shared catalog, preview and original-byte check. Both architectures passed. This covers the copied application and the DMG layout. Finder gestures, quarantine and notarization have separate verification scopes. [macOS disk image run](https://github.com/stvlynn/OpenLR/actions/runs/42277396982) · [Apple disk image packaging](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)

## macOS default store restart

Ordinary macOS launches use the system's persistent WKWebView default store. The main native suite uses ephemeral stores on macOS to give each workflow a separate catalog. Run this additional check once in a fresh disposable macOS user account, such as each GitHub-hosted macOS job. The harness still isolates its socket, agent descriptor and adapter files. WKWebView catalog data and MyGo window state remain in the disposable account until it is removed. Use a fresh account for each run.

```sh
node scripts/native-organization-smoke.mjs build/release/darwin-universal/OpenLR.app/Contents/MacOS/OpenLR --macos-default-store
```

The check requires an empty catalog and default preferences. It imports three generated PNGs, saves catalog changes and a non-default preference, then restarts the packaged app and checks the new process, persisted photo IDs, stack, album, edits, named version, preset and preference. It verifies the preset's effect on rendered pixels and reads the saved original bytes from the reopened catalog. See [acceptance](acceptance.md) for executed results. [Apple WebKit data stores](https://developer.apple.com/documentation/webkit/wkwebsitedatastore) · [GitHub-hosted runner isolation](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)

## Local Linux acceptance

Use a Linux checkout with Linux-installed `node_modules`, Go 1.27.3+ and Node 24. When running under WSL, keep the checkout and Go caches in a persistent Linux directory; do not reuse Windows native npm binaries or assume `/tmp` survives separate WSL invocations. The complete suite also needs Chrome for the shared-album visitor and to generate the video fixture and decode its exported media independently of the application's WebKitGTK runtime.

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-0 gstreamer1.0-plugins-bad xvfb
npm ci
google-chrome --version
go test ./...
go test -race ./...
go vet ./...
node scripts/desktop.mjs build -o build/release -platform linux/amd64
xvfb-run -a dbus-run-session -- node scripts/native-suite.mjs build/release/linux-amd64/openlr
```

Install Chrome from its official Linux distribution before the version check if absent. Set `OPENLR_TEST_METADATA=1` when the independent [ExifTool oracle](export-metadata.md) has been provisioned, so missing validation tools fail visibly. The local commands above run the unpacked build. Hosted Xvfb verification installs the generated Debian package with `--no-install-recommends` after the paired dependency comparison. Xvfb verifies the real GTK/WebKit application and IPC bridge in a virtual X server, with isolated test catalogs. Physical displays, GPU drivers, system choosers, signing and macOS have separate verification scopes. [APT comparison](../research/linux-dependencies.md#apt-recommendations-comparison)

## Windows file-open verification

MyGo forwards paths for the packaged application's configured file associations to the running workspace. For a standalone check, pass a packaged Windows executable to the file-open smoke. The smoke launches the executable with photo arguments and uses the live CLI to read the resulting workspace and files.

```powershell
node scripts/native-file-open-smoke.mjs build/startup-trace/windows-amd64/OpenLR.exe
```

The Windows WebView2 run against `f6af855` opened a generated 32×24 PNG from an absolute path containing spaces. A second process forwarded a 30×22 PNG with a relative Unicode filename from a different working directory and exited successfully. The original process kept its agent session and showed the new photo in Detail. A repeated open from Grid reused the existing photo ID. Both IDs survived a restart of the private profile. Decoded previews and rendered PNGs matched the fixtures at every pixel, and original exports matched both source files byte for byte.

This verifies argument delivery to the packaged executable and its existing Windows instance. Windows Explorer association registration, system choosers, and file-open behavior on other platforms remain separate checks. See [file-open smoke](../scripts/native-file-open-smoke.mjs).
